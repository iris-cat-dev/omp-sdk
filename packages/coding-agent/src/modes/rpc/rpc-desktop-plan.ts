import type { AgentToolResult, CustomMessage } from "@oh-my-pi/pi-agent-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { prompt } from "@oh-my-pi/pi-utils";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { PlanApprovalDetails } from "../../plan-mode/approved-plan";
import { isDesktopPlanTool, type PlanModeState } from "../../plan-mode/state";
import planModeApprovedPrompt from "../../prompts/system/plan-mode-approved.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { MAX_RPC_FRAME_BYTES } from "./rpc-frame";
import type { RpcDesktopPlanReview, RpcDesktopPlanState } from "./rpc-types";

const MODE = "desktop-plan-mode";
const REVIEW = "desktop-plan-review";
const RESOLVED = "desktop-plan-review-resolved";
const INITIAL_DRAFT = "local://PLAN.md";
const REVIEW_ID = /^([^:]+):([a-f\d-]{36})$/;

export function isDesktopPlanEntry(customType: string): boolean {
	return customType === MODE || customType === REVIEW || customType === RESOLVED;
}

interface JournalPlanState {
	enabled: boolean;
	draftPath: string;
	review?: RpcDesktopPlanReview;
	approvedPath: string | null;
}

interface ToolPresentation {
	enabled: string[];
	mounted: string[];
}

function approvedPath(id: string): string {
	const revision = REVIEW_ID.exec(id)?.[2];
	if (!revision) throw new Error("Invalid Desktop plan review ID.");
	return `local://approved-${revision}.md`;
}

function parseReview(data: Record<string, unknown>): RpcDesktopPlanReview | undefined {
	const { id, title, path, markdown } = data;
	if (
		typeof id === "string" &&
		REVIEW_ID.test(id) &&
		typeof title === "string" &&
		typeof path === "string" &&
		typeof markdown === "string"
	) {
		return { id, title, path, markdown };
	}
	return undefined;
}

/** Owns the typed Desktop review; AgentSession owns model turns and tool enforcement. */
export class RpcDesktopPlan {
	#state: JournalPlanState = { enabled: false, draftPath: INITIAL_DRAFT, approvedPath: null };
	#previousTools: ToolPresentation | undefined;
	#unpublished: RpcDesktopPlanReview | undefined;
	#proposal: Promise<AgentToolResult<PlanApprovalDetails>> | undefined;
	#transitioning = false;

	constructor(private readonly session: AgentSession) {}

	get enabled(): boolean {
		return this.#state.enabled;
	}

	get state(): RpcDesktopPlanState {
		const { enabled, review } = this.#state;
		return { enabled, ...(review && !this.#unpublished ? { review } : {}) };
	}

	assertCanPrompt(): void {
		if (this.#state.review) throw new Error("Resolve the pending plan review before sending another message.");
	}

	/** Publish only once, after the proposal's tool result and terminal agent_end were forwarded. */
	observe(event: AgentSessionEvent): RpcDesktopPlanReview | undefined {
		if (event.type !== "agent_end" || event.isTerminal === false || this.#transitioning) return undefined;
		const review = this.#unpublished;
		this.#unpublished = undefined;
		return review;
	}

	/** Rehydrate from the selected branch without replaying a review event or an approval. */
	async restore(): Promise<void> {
		await this.#proposal?.catch(() => {});
		const next: JournalPlanState = { enabled: false, draftPath: INITIAL_DRAFT, approvedPath: null };
		const sessionId = this.session.sessionManager.getSessionId();
		const consumed = new Set<string>();
		for (const entry of this.session.sessionManager.getEntries()) {
			if (
				entry.type === "custom" &&
				(entry.customType === RESOLVED || entry.customType === MODE) &&
				isRecord(entry.data) &&
				typeof entry.data.id === "string"
			) {
				consumed.add(entry.data.id);
			}
		}
		for (const entry of this.session.sessionManager.getBranchView()) {
			if (entry.type !== "custom" || !isRecord(entry.data)) continue;
			const data = entry.data;
			if (entry.customType === MODE && typeof data.enabled === "boolean" && typeof data.draftPath === "string") {
				next.enabled = data.enabled;
				next.draftPath = data.draftPath;
				next.review = undefined;
			} else if (entry.customType === REVIEW && next.enabled) {
				const review = parseReview(data);
				if (review) {
					next.draftPath = review.path;
					next.review = review;
				}
			} else if (entry.customType === RESOLVED && next.review && data.id === next.review.id) {
				if (data.choice === "approve") {
					next.enabled = false;
					next.approvedPath = approvedPath(next.review.id);
				}
				next.review = undefined;
			}
		}
		if (next.review && (consumed.has(next.review.id) || !next.review.id.startsWith(`${sessionId}:`))) {
			next.review = undefined;
		}
		await this.#apply(next);
		this.#unpublished = undefined;
	}

	async setEnabled(enabled: boolean): Promise<RpcDesktopPlanState> {
		if (enabled === this.#state.enabled) return this.state;
		if (
			enabled &&
			(this.session.isBusyForSnapshot || this.session.getGoalModeState() || this.session.getVibeModeState()?.enabled)
		) {
			throw new Error("Plan mode requires an idle session without another active workflow.");
		}
		const transition = async () => {
			if (!enabled && this.session.isStreaming) await this.session.abort({ reason: USER_INTERRUPT_LABEL });
			await this.#proposal?.catch(() => {});
			const { review, ...state } = this.#state;
			const next = { ...state, enabled };
			await this.#commit(next, MODE, { enabled, draftPath: next.draftPath, ...(review ? { id: review.id } : {}) });
			this.#unpublished = undefined;
		};
		this.#transitioning = true;
		try {
			if (enabled) await transition();
			else await this.session.runModeExitTeardown(transition);
			return this.state;
		} finally {
			this.#transitioning = false;
		}
	}

	/** Approval consumes the review in the journal before the host can admit its one execution turn. */
	async resolve(reviewId: string, choice: "approve" | "refine"): Promise<CustomMessage | undefined> {
		const review = this.#state.review;
		const sessionId = this.session.sessionManager.getSessionId();
		if (!review || review.id !== reviewId || !review.id.startsWith(`${sessionId}:`) || this.#unpublished) {
			throw new Error("This plan review is no longer pending.");
		}
		if (this.session.isBusyForSnapshot) {
			throw new Error("Wait for the planning turn to finish before resolving the review.");
		}
		const before = this.#state;
		const next: JournalPlanState = { ...before, review: undefined };
		let execution: CustomMessage | undefined;
		if (choice === "approve") {
			const snapshotPath = approvedPath(review.id);
			await this.session.storeApprovedPlanSnapshot(snapshotPath, review.markdown);
			if (this.#state !== before || this.session.sessionManager.getSessionId() !== sessionId) {
				throw new Error("This plan review is no longer pending.");
			}
			next.enabled = false;
			next.approvedPath = snapshotPath;
			execution = {
				role: "custom",
				customType: "plan-mode-approved",
				content: prompt.render(planModeApprovedPrompt, {
					planFilePath: snapshotPath,
					planContent: review.markdown,
					contextPreserved: true,
				}),
				display: false,
				attribution: "agent",
				timestamp: Date.now(),
			};
		}
		await this.#commit(next, RESOLVED, { id: review.id, choice });
		if (execution) this.session.markPlanReferenceSent();
		return execution;
	}

	async #commit(next: JournalPlanState, customType: string, data: unknown): Promise<void> {
		const before = this.#state;
		await this.#apply(next);
		try {
			await this.session.sessionManager.appendEntriesAtomically(() =>
				this.session.sessionManager.appendCustomEntry(customType, data),
			);
		} catch (error) {
			await this.#apply(before);
			throw error;
		}
	}

	async #apply(next: JournalPlanState): Promise<void> {
		const currentMode = this.session.getPlanModeState();
		const nextMode: PlanModeState | undefined = next.enabled
			? {
					enabled: true,
					planFilePath: next.draftPath,
					workflow: "iterative",
					reentry: next.draftPath !== INITIAL_DRAFT,
					desktop: { awaitingReview: next.review !== undefined },
				}
			: undefined;
		this.session.setPlanModeState(nextMode);
		try {
			if (nextMode && !this.#previousTools) {
				if (!this.session.hasBuiltInTool("write") || !this.session.hasBuiltInTool("edit")) {
					throw new Error("Plan mode requires the built-in write and edit tools.");
				}
				const enabled = this.session.getEnabledToolNames();
				const mounted = this.session.getMountedXdevToolNames();
				const allowed = enabled.filter(name => isDesktopPlanTool(name) && this.session.hasBuiltInTool(name));
				await this.session.setActiveToolPresentation([...new Set([...allowed, "edit", "write"])], []);
				this.#previousTools = { enabled, mounted };
			} else if (!nextMode && this.#previousTools) {
				const { enabled, mounted } = this.#previousTools;
				await this.session.setActiveToolPresentation(enabled, mounted);
				this.#previousTools = undefined;
			}
		} catch (error) {
			this.session.setPlanModeState(currentMode);
			throw error;
		}
		this.session.setPlanProposalHandler(nextMode ? title => this.#trackProposal(title) : null, {
			waitForUser: false,
		});
		this.session.setDesktopPlanReference(next.approvedPath);
		this.#state = next;
	}

	#trackProposal(title: string): Promise<AgentToolResult<PlanApprovalDetails>> {
		if (this.#transitioning || this.#proposal) throw new ToolError("Plan mode changed before the proposal.");
		const proposal = this.#propose(title).finally(() => {
			this.#proposal = undefined;
		});
		this.#proposal = proposal;
		return proposal;
	}

	async #propose(title: string): Promise<AgentToolResult<PlanApprovalDetails>> {
		const before = this.#state;
		const sessionId = this.session.sessionManager.getSessionId();
		if (before.review) throw new ToolError("A plan is already awaiting review.");
		const draft = await this.session.resolvePlanProposal(title);
		if (this.#transitioning || this.#state !== before || this.session.sessionManager.getSessionId() !== sessionId) {
			throw new ToolError("Plan mode changed before the plan could be submitted.");
		}
		const review: RpcDesktopPlanReview = {
			id: `${sessionId}:${crypto.randomUUID()}`,
			title: draft.title,
			path: draft.planFilePath,
			markdown: draft.planContent,
		};
		// A frame must carry the exact reviewed bytes even on unnegotiated (v1) Desktop hosts.
		if (Buffer.byteLength(JSON.stringify(review)) > MAX_RPC_FRAME_BYTES - 4096) {
			throw new ToolError("The plan is too large to review. Shorten the Markdown file and submit it again.");
		}
		const next = { ...before, draftPath: review.path, review };
		this.#unpublished = review;
		try {
			await this.#commit(next, REVIEW, review);
		} catch (error) {
			this.#unpublished = undefined;
			throw error;
		}
		return {
			content: [{ type: "text", text: "Plan ready for review." }],
			details: { planFilePath: review.path, title: review.title, planExists: true },
		};
	}
}

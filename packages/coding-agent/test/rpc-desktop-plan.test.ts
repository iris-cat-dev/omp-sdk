import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcDesktopPlanReview } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";

async function start(
	root: TempDir,
	options?: { session?: string; disabled?: boolean; failStart?: boolean },
): Promise<RpcClient> {
	const client = new RpcClient({
		command: [process.execPath, path.join(import.meta.dir, "fixtures", "desktop-plan-rpc-agent.ts")],
		cwd: root.path(),
		env: {
			PI_CODING_AGENT_DIR: root.path(),
			DESKTOP_PLAN_SESSION: options?.session ?? "",
			DESKTOP_PLAN_DISABLED: options?.disabled ? "1" : "0",
			DESKTOP_PLAN_FAIL_START: options?.failStart ? "1" : "0",
		},
	});
	await client.start();
	return client;
}

async function submit(client: RpcClient, text: string): Promise<RpcDesktopPlanReview> {
	const { promise, resolve } = Promise.withResolvers<RpcDesktopPlanReview>();
	const unsubscribe = client.onDesktopPlanReview(resolve);
	try {
		await client.promptAndWait(text);
		return await withTimeout(promise, 5_000, "No Desktop plan review was received");
	} finally {
		unsubscribe();
	}
}

const ORIGINAL = "# Draft\n\noriginal & <markup>\n";

// The real model loop must yield at a successful xd://propose without another call;
// approval must resume as hidden agent input using the submitted bytes even if the draft changes.
test("a file-backed plan review yields, survives reopen, and implements the displayed snapshot once", async () => {
	using root = TempDir.createSync("@desktop-plan-rpc-");
	const client = await start(root);
	let filename: string;
	let review: RpcDesktopPlanReview;
	try {
		const events: string[] = [];
		client.onSessionEvent(event => events.push(event.type));
		client.onDesktopPlanReview(() => events.push("plan_review"));
		expect(await client.setDesktopPlanMode(true)).toEqual({ enabled: true });
		const tools = (await client.getState()).dumpTools?.map(tool => tool.name);
		expect(tools).toContain("write");
		expect(tools).not.toContain("bash");
		review = await submit(client, "Make a plan");
		expect(review).toMatchObject({ title: "sample", path: "local://sample-plan.md", markdown: ORIGINAL });
		expect(events.indexOf("agent_end")).toBeGreaterThan(-1);
		expect(events.indexOf("plan_review")).toBeGreaterThan(events.indexOf("agent_end"));
		expect(events.filter(event => event === "agent_start")).toHaveLength(1);
		await expect(fs.stat(root.join("workspace.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(await client.getDesktopPlanState()).toEqual({ enabled: true, review });
		const state = await client.getState();
		if (!state.sessionFile) throw new Error("Missing file-backed session");
		filename = state.sessionFile;
	} finally {
		await client.stop();
	}

	const draftPath = path.join(filename.slice(0, -".jsonl".length), "local", "sample-plan.md");
	await fs.writeFile(draftPath, "# Changed outside review\n");
	const reopened = await start(root, { session: filename });
	try {
		let starts = 0;
		let reviews = 0;
		reopened.onSessionEvent(event => {
			if (event.type === "agent_start") starts++;
		});
		reopened.onDesktopPlanReview(() => {
			reviews++;
		});
		expect(await reopened.getDesktopPlanState()).toEqual({ enabled: true, review });
		const [approval, duplicate] = await Promise.allSettled([
			reopened.resolveDesktopPlanReview(review.id, "approve"),
			reopened.resolveDesktopPlanReview(review.id, "approve"),
		]);
		expect(approval).toEqual({ status: "fulfilled", value: { enabled: false } });
		expect(duplicate).toMatchObject({
			status: "rejected",
			reason: { message: "This plan review is no longer pending." },
		});
		await reopened.waitForSettled(5_000);
		const messages = await reopened.getMessages();
		expect(starts).toBe(1);
		expect(reviews).toBe(0);
		expect(messages.filter(message => message.role === "user")).toHaveLength(1);
		expect(messages).toContainEqual(
			expect.objectContaining({ role: "custom", customType: "plan-mode-approved", display: false }),
		);
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Executed original snapshot." }],
		});
		expect(await fs.readFile(draftPath, "utf8")).toBe("# Changed outside review\n");
		expect((await reopened.getState()).dumpTools?.map(tool => tool.name)).toContain("bash");

		const savedReview = (await reopened.getEntries()).entries.find(
			entry => entry.type === "custom" && entry.customType === "desktop-plan-review",
		);
		if (!savedReview) throw new Error("Review snapshot is missing from the session branch");
		await reopened.navigateTree(savedReview.id);
		expect(await reopened.getDesktopPlanState()).toEqual({ enabled: true });
		const rewound = await reopened.resolveDesktopPlanReview(review.id, "approve").catch(error => error);
		expect(rewound).toMatchObject({ message: "This plan review is no longer pending." });
	} finally {
		await reopened.stop();
	}
}, 30_000);

test("refine retains the draft and read-only mode; switching off dismisses the next revision without running it", async () => {
	using root = TempDir.createSync("@desktop-plan-refine-");
	const client = await start(root);
	try {
		await client.setDesktopPlanMode(true);
		const first = await submit(client, "Make a plan");
		expect(await client.resolveDesktopPlanReview(first.id, "refine")).toEqual({ enabled: true });
		const next = await submit(client, "Refine the same plan");
		expect(next.path).toBe(first.path);
		expect(next.id).not.toBe(first.id);
		expect(next.markdown).toBe("# Updated\n\nRevised steps.\n");
		const stale = await client.resolveDesktopPlanReview(first.id, "approve").catch(error => error);
		expect(stale).toMatchObject({ message: "This plan review is no longer pending." });
		expect(await client.getDesktopPlanState()).toEqual({ enabled: true, review: next });
		const before = await client.getMessages();
		expect(await client.setDesktopPlanMode(false)).toEqual({ enabled: false });
		expect(await client.getMessages()).toEqual(before);
		const dismissed = await client.resolveDesktopPlanReview(next.id, "approve").catch(error => error);
		expect(dismissed).toMatchObject({ message: "This plan review is no longer pending." });
		expect(await client.setDesktopPlanMode(true)).toEqual({ enabled: true });
	} finally {
		await client.stop();
	}
}, 30_000);

test("a failed execution preflight reports a consumed approval without starting or repeating the turn", async () => {
	using root = TempDir.createSync("@desktop-plan-execution-error-");
	const client = await start(root);
	let filename: string;
	let review: RpcDesktopPlanReview;
	try {
		await client.setDesktopPlanMode(true);
		review = await submit(client, "Make a plan");
		const state = await client.getState();
		if (!state.sessionFile) throw new Error("Missing file-backed session");
		filename = state.sessionFile;
	} finally {
		await client.stop();
	}
	const reopened = await start(root, { session: filename, failStart: true });
	try {
		const events: string[] = [];
		reopened.onSessionEvent(event => events.push(event.type));
		expect(await reopened.resolveDesktopPlanReview(review.id, "approve")).toEqual({
			enabled: false,
			executionError: expect.stringContaining("No API key found for anthropic"),
		});
		expect(events).not.toContain("agent_start");
		expect(await reopened.getDesktopPlanState()).toEqual({ enabled: false });
		const repeated = await reopened.resolveDesktopPlanReview(review.id, "approve").catch(error => error);
		expect(repeated).toMatchObject({ message: "This plan review is no longer pending." });
	} finally {
		await reopened.stop();
	}
}, 30_000);

test("plain RPC has no Desktop Plan commands", async () => {
	using root = TempDir.createSync("@desktop-plan-opt-in-");
	const client = await start(root, { disabled: true });
	try {
		const failure = await client.getDesktopPlanState().catch(error => error);
		expect(failure).toMatchObject({ command: "get_plan_state", message: "Unknown command: get_plan_state" });
	} finally {
		await client.stop();
	}
}, 30_000);

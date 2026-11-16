import type { AgentSession } from "../../session/agent-session";
import type { SessionInfoUpdateEvent } from "./wire/rpc-wire.generated";

/** Publishes the current native title, independently of agent turns and event filters. */
export class RpcSessionTitles {
	#last: SessionInfoUpdateEvent | undefined;
	#disposed = false;
	readonly #unsubscribeName: () => void;

	constructor(
		private readonly session: Pick<AgentSession, "sessionManager">,
		private readonly output: (frame: SessionInfoUpdateEvent) => void,
	) {
		// AgentSession retains this manager when switching files; never attach per-file listeners.
		this.#unsubscribeName = session.sessionManager.onSessionNameChanged(() => this.refresh());
		this.refresh();
	}

	/** Session switches load title metadata without invoking onSessionNameChanged. */
	refresh(): void {
		if (this.#disposed) return;
		const manager = this.session.sessionManager;
		const frame: SessionInfoUpdateEvent = {
			type: "session_info_update",
			sessionId: manager.getSessionId(),
			title: manager.getSessionName(),
			titleSource: manager.titleSource,
		};
		if (
			this.#last?.sessionId === frame.sessionId &&
			this.#last.title === frame.title &&
			this.#last.titleSource === frame.titleSource
		) return;
		this.#last = frame;
		this.output(frame);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribeName();
	}
}

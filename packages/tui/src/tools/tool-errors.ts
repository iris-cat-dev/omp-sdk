import { AgentToolError } from "@oh-my-pi/pi-agent-core";

/** Structured tool failure shared by selector parsing and host tool execution. */
export class ToolError<T = unknown> extends AgentToolError<T> {
	constructor(
		message: string,
		readonly context?: Record<string, unknown>,
		details?: T,
	) {
		super(message, undefined, details);
		this.name = "ToolError";
	}

	/** Render error for LLM consumption. Override for custom formatting. */
	render(): string {
		return this.message;
	}
}

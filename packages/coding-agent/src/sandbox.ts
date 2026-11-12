import type { SandboxFs } from "./sandbox-fs";
import type { AgentSandbox } from "./sandbox-fs";
import { sandboxJsTool } from "./sandbox-js";
import { sandboxFetchTool } from "./sandbox-fetch";
export { openSandboxFs, type AgentSandbox, type SandboxFs } from "./sandbox-fs";
import { type as arkType } from "@oh-my-pi/omptype";
import type { ToolDefinition } from "./extensibility/extensions/types";
import sandboxSystemPrompt from "./prompts/sandbox-system.md" with { type: "text" };
import * as prompt from "@oh-my-pi/pi-utils/prompt";

export const SANDBOX_TOOL_NAMES = ["sandbox_read", "sandbox_write", "sandbox_list"] as const;
export const SANDBOX_SYSTEM_PROMPT = buildSandboxSystemPrompt();

export function buildSandboxSystemPrompt(userInstructions?: string, sandbox?: AgentSandbox): string {
	return prompt.render(sandboxSystemPrompt, { userInstructions, javascriptEnabled: sandbox?.javascript === true, networkEnabled: sandbox?.network === "public", imageGenerationEnabled: sandbox?.imageGeneration === true });
}


export function sandboxTools(files: SandboxFs, sandbox?: AgentSandbox): ToolDefinition[] {
	if (sandbox?.javascript !== undefined && typeof sandbox.javascript !== "boolean") throw new Error("Invalid sandbox JavaScript capability");
	if (sandbox?.network !== undefined && sandbox.network !== "public") throw new Error("Invalid sandbox network capability");
	const parameters = arkType({ path: "string" });
	const writeParameters = arkType({ path: "string", content: "string" });
	const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
	const protect = (run: () => string) => {
		try { return result(run()); } catch (error) {
			if (error instanceof Error && error.message === "Sandbox file access denied") return { ...result("Sandbox file access denied"), isError: true };
			throw new Error("Sandbox filesystem operation failed", { cause: error });
		}
	};
	const tools: ToolDefinition[] = [
		{ name: "sandbox_read", label: "Read sandbox file", description: "Read a UTF-8 file in the private namespace (at most 1 MiB).", parameters, execute: async (_id, args) => protect(() => files.read(parameters.assert(args).path, 1024 * 1024).toString("utf8")) },
		{ name: "sandbox_write", label: "Write sandbox file", description: "Write UTF-8 text in the private namespace (at most 1 MiB); existing parent directories required.", parameters: writeParameters, execute: async (_id, args) => protect(() => { const { path, content } = writeParameters.assert(args); if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("Sandbox file access denied"); files.write(path, Buffer.from(content)); return "File written"; }) },
		{ name: "sandbox_list", label: "List sandbox files", description: "List up to 1024 entries in a private namespace directory; use . for its root. Links and special files are denied.", parameters, execute: async (_id, args) => protect(() => files.list(parameters.assert(args).path).map(entry => entry.name + (entry.isDirectory ? "/" : "")).join("\n")) },
	];
	if (sandbox?.javascript) tools.push(sandboxJsTool(files, sandbox.network === "public"));
	if (sandbox?.network === "public") tools.push(sandboxFetchTool());
	return tools;
}

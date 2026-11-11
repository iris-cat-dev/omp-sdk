import "./node-platform";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { ModelRegistry, ProviderConfigInput } from "./config/model-registry";
import type { AgentSandbox } from "./sandbox";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { parseArgs } from "./cli/args";
import { all } from "./config/registry";
import { Settings } from "./config/settings";
import { initializeNodeSdk } from "./node-bootstrap";
import { runRpcMode } from "./modes/rpc/rpc-mode";
import { claimRpcInput } from "./modes/rpc/rpc-input";
import { cfgColorBlindMode, cfgSymbolPreset, cfgThemeDark, cfgThemeLight } from "./modes/settings";
import { checkPluginStartup } from "./extensibility/plugins/startup-check";
import { createAgentSession } from "./sdk";
import { SessionManager } from "./session/session-manager";
import { resolveResumableSession } from "./session/session-listing";
import { closeDaemonClients, daemonClientForProject } from "./launch/client";
import { registerDaemonProjectPresence } from "./launch/presence";
import { BUILTIN_TOOL_NAMES } from "./tools/builtin-names";
import { cfgToolsApprovalMode } from "./tools/settings";
import { ProxyPolicyController, type ProxyPolicy, setDefaultProxyPolicyController } from "@oh-my-pi/pi-ai/utils/proxy";
import { randomUUID } from "node:crypto";

export * from "./modes/rpc/rpc-mode";
export const NODE_RPC_SANDBOX_VERSION = 1;
export { openSandboxFs, type SandboxFs } from "./sandbox-fs";

initializeNodeSdk(import.meta.url);

export interface NodeRpcHostOptions {
	cwd: string;
	agentDir?: string;
	proxyPolicy?: ProxyPolicy;
	protocolMode?: "rpc" | "rpc-ui";
	model?: string;
	thinkingOptionId?: string;
	session?: string;
	noSession?: boolean;
	systemPrompt?: string;
	extraArgs?: string[];
	extensions?: string[];
	disallowedTools?: string[];
	configFiles?: string[];
	desktopPluginPrompts?: boolean;
	sandbox?: AgentSandbox;
	/** Trusted Desktop local-model provider adapter, never a model extension. */
	modelBridgeExtension?: string;
}

const supportedParsedOptions: Readonly<Record<string, true>> = {
	model: true,
	provider: true,
	thinking: true,
	config: true,
	extensions: true,
	noExtensions: true,
	tools: true,
	noTools: true,
	noLsp: true,
	noContextFiles: true,
	noSkills: true,
	noRules: true,
	systemPrompt: true,
	appendSystemPrompt: true,
	approvalMode: true,
	autoApprove: true,
	smol: true,
	slow: true,
	plan: true,
	noUi: true,
	noSession: true,
	sessionDir: true,
	messages: true,
	fileArgs: true,
	unknownFlags: true,
	unrecognizedFlags: true,
	invalidFlagValues: true,
};

/** Run the existing full RPC protocol around an SDK session, without entering the Bun CLI. */
export async function startNodeRpcHost(options: NodeRpcHostOptions): Promise<never> {
	const input = claimRpcInput();
	if (!path.isAbsolute(options.cwd)) throw new Error("Node SDK cwd must be absolute");
	const proxyController = new ProxyPolicyController(options.proxyPolicy);
	setDefaultProxyPolicyController(proxyController);
	const parsed = parseArgs([
		...(options.model ? ["--model", options.model] : []),
		...(options.thinkingOptionId ? ["--thinking", options.thinkingOptionId] : []),
		...(options.extraArgs ?? []),
	]);
	if (parsed.unrecognizedFlags.length || parsed.invalidFlagValues.length) {
		throw new Error(
			`Invalid Node SDK session options: ${[...parsed.unrecognizedFlags, ...parsed.invalidFlagValues].join(", ")}`,
		);
	}
	if (parsed.messages.length || parsed.fileArgs.length || parsed.unknownFlags.size) {
		throw new Error("Node SDK startup accepts session options, not an initial CLI prompt");
	}
	for (const [key, value] of Object.entries(parsed)) {
		if (value !== undefined && value !== false && !supportedParsedOptions[key]) {
			throw new Error(`Node SDK backend does not support the CLI option '${key}'`);
		}
	}
	for (const check of options.sandbox ? [] : await checkPluginStartup(options.cwd, { disableFailed: true })) {
		if (check.disabled) {
			console.error(`Disabled failed plugin ${check.name} (${check.scope}): ${check.errors.join("; ")}`);
		}
	}
	const agentDir = options.agentDir ?? getAgentDir();
	const settings = await Settings.init({
		cwd: options.cwd,
		agentDir,
		globalOnly: options.sandbox !== undefined,
		configFiles: options.sandbox ? [] : [...(options.configFiles ?? []), ...(parsed.config ?? [])],
	});
	// RPC bypasses CLI startup, but tool prompts still use its themed control labels.
	await initTheme(
		false,
		cfgSymbolPreset.get(settings),
		cfgColorBlindMode.get(settings),
		cfgThemeDark.get(settings),
		cfgThemeLight.get(settings),
	);
	for (const setting of all()) {
		if (setting.definition.protocolDefault?.includes("rpc")) setting.pinDefault(settings);
	}
	if (parsed.approvalMode) cfgToolsApprovalMode.override(settings, parsed.approvalMode);
	else if (parsed.autoApprove) cfgToolsApprovalMode.override(settings, "yolo");
	if (parsed.smol || parsed.slow || parsed.plan) {
		settings.overrideModelRoles({ smol: parsed.smol, slow: parsed.slow, plan: parsed.plan });
	}
	const sessionDir = parsed.sessionDir ?? SessionManager.getDefaultSessionDir(options.cwd, agentDir);
	let sessionManager: SessionManager | undefined;
	if (options.noSession || parsed.noSession) {
		if (options.session) throw new Error("Cannot combine a saved session with noSession");
		sessionManager = SessionManager.inMemory(options.cwd);
	} else if (options.session) {
		const candidate = path.resolve(options.cwd, options.session);
		let sessionFile: string | undefined;
		try {
			if ((await fs.stat(candidate)).isFile()) sessionFile = candidate;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		if (!sessionFile) {
			const match = await resolveResumableSession(options.session, options.cwd, sessionDir, {
				allowGlobalFallback: true,
			});
			sessionFile = match?.session.path;
		}
		if (!sessionFile) throw new Error(`Saved session not found: ${options.session}`);
		sessionManager = await SessionManager.open(sessionFile, sessionDir, undefined, { throwIfMissing: true });
	}
	const denied = new Set(options.disallowedTools ?? []);
	let toolNames = parsed.noTools ? [] : parsed.tools;
	if (denied.size) {
		// Image generation is settings-gated, not part of the built-in manifest.
		// A denylist must not turn unrelated denials into an image whitelist denial.
		toolNames = (toolNames ?? [...BUILTIN_TOOL_NAMES, "generate_image"]).filter(name => !denied.has(name));
	}
	const pluginPrompts=new Map<string,{resolve(value:DesktopPluginPromptContribution[]):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
	const requestPluginPrompts=()=>{
		const id=randomUUID();const {promise,resolve,reject}=Promise.withResolvers<DesktopPluginPromptContribution[]>();
		const timer=setTimeout(()=>{pluginPrompts.delete(id);reject(new Error("Desktop plugin prompt hook timed out"));},30_000);
		pluginPrompts.set(id,{resolve,reject,timer});process.stdout.write(JSON.stringify({type:"desktop_plugin_prompt_request",id})+"\n");return promise;
	};
	const result = await createAgentSession({
		proxyController,
		sandbox: options.sandbox,
		setupModelRegistry: options.sandbox && options.modelBridgeExtension ? async registry => {
			if (!path.isAbsolute(options.modelBridgeExtension!)) throw new Error("Model bridge adapter must be absolute");
			const module: unknown = createRequire(import.meta.url)(options.modelBridgeExtension!);
			if (!module || typeof module !== "object" || !("default" in module) || typeof module.default !== "function") throw new Error("Model bridge adapter is invalid");
			const handlers: Array<(event: unknown, context: { modelRegistry: ModelRegistry }) => void | Promise<void>> = [];
			await module.default(Object.freeze({
				registerProvider: (name: string, config: ProviderConfigInput) => registry.registerProvider(name, config, "<trusted-model-bridge>"),
				on: (event: string, handler: typeof handlers[number]) => {
					if (event !== "session_start") throw new Error("Sandbox model bridge hooks denied");
					handlers.push(handler);
				},
			}));
			for (const handler of handlers) await handler(undefined, { modelRegistry: registry });
		} : undefined,
		cwd: options.cwd,
		agentDir,
		settings,
		sessionManager,
		serviceOwnerId: process.env.OMP_DESKTOP_SERVICE_OWNER || undefined,
		modelPattern: parsed.provider && parsed.model ? `${parsed.provider}/${parsed.model}` : parsed.model,
		thinkingLevel: parsed.thinking,
		systemPrompt: options.sandbox ? options.systemPrompt : options.systemPrompt ?? parsed.systemPrompt,
		appendSystemPrompt: parsed.appendSystemPrompt,
		additionalExtensionPaths: [...(options.extensions ?? []), ...(parsed.extensions ?? [])],
		extensions: !options.sandbox && options.desktopPluginPrompts ? [pi=>{
			pi.on("before_agent_start",async event=>{
				const contributions=await requestPluginPrompts();const additions:string[]=[];
				for(const contribution of contributions){
					if(contribution.text)additions.push(contribution.text);
					for(const name of contribution.skills??[]){
						const skill=result.session.skills.find(skill=>skill.name===name);
						if(!skill)throw new Error(`Selected plugin skill is unavailable: ${name}`);
						additions.push(`<skill name=${JSON.stringify(name)} path=${JSON.stringify(skill.filePath)}>\n${await fs.readFile(skill.filePath,"utf8")}\n</skill>`);
					}
					for(const name of contribution.tools??[]){const tool=pi.getAllTools().find(tool=>tool.name===name);if(!tool)throw new Error(`Selected plugin tool is unavailable: ${name}`);additions.push(`Selected tool ${tool.name}: ${tool.description}`);}
				}
				return {systemPrompt:[...event.systemPrompt,...additions]};
			});
		}] : undefined,
		disableExtensionDiscovery: parsed.noExtensions,
		toolNames,
		enableLsp: parsed.noLsp ? false : undefined,
		noContextFiles: parsed.noContextFiles,
		skills: parsed.noSkills ? [] : undefined,
		rules: parsed.noRules ? [] : undefined,
		interactivePrompts: options.protocolMode === "rpc-ui",
		allowSessionModelFallback: false,
	});
	if (result.extensionsResult.errors.length) {
		await result.session.dispose();
		throw new Error(
			`Node SDK extensions failed: ${result.extensionsResult.errors.map(error => `${error.path}: ${error.error}`).join("; ")}`,
		);
	}
	const daemonPresence = options.sandbox ? undefined : await registerDaemonProjectPresence(options.cwd);
	if (!options.sandbox) settings.startWatching();
	try {
		await result.session.sessionManager.ensureOnDisk();
		return await runRpcMode(result.session, {
			input,
			setToolUIContext: options.protocolMode === "rpc-ui" ? result.setToolUIContext : undefined,
			headless: parsed.noUi,
			mcpManager: result.mcpManager,
			subagentEventBus: result.subagentEventBus,
			onCustomFrame(frame){
				if(!frame||typeof frame!=="object"||!("type" in frame)||frame.type!=="desktop_plugin_prompt_response")return false;
				if(!("id" in frame)||typeof frame.id!=="string")throw new Error("Malformed Desktop prompt response");
				const pending=pluginPrompts.get(frame.id);if(!pending)return true;pluginPrompts.delete(frame.id);clearTimeout(pending.timer);
				if("error" in frame&&typeof frame.error==="string"){pending.reject(new Error(frame.error));return true;}
				if(!("contributions" in frame)||!Array.isArray(frame.contributions)){pending.reject(new Error("Malformed Desktop prompt contributions"));return true;}
				const contributions:DesktopPluginPromptContribution[]=[];
				for(const raw of frame.contributions){
					if(!raw||typeof raw!=="object"||(raw.text!==undefined&&typeof raw.text!=="string")||(raw.skills!==undefined&&(!Array.isArray(raw.skills)||raw.skills.some((name:unknown)=>typeof name!=="string")))||(raw.tools!==undefined&&(!Array.isArray(raw.tools)||raw.tools.some((name:unknown)=>typeof name!=="string")))){pending.reject(new Error("Malformed Desktop prompt contribution"));return true;}
					contributions.push(raw);
				}
				pending.resolve(contributions);return true;
			},
		});
	} finally {
		settings.stopWatching();
		try {
			await result.session.dispose();
		} finally {
			await daemonPresence?.close();
		}
	}
}

/** Stop a persisted project daemon through its existing broker protocol. */
export async function stopNodeRpcDaemon(input: { cwd: string; name: string; id?: string }): Promise<void> {
	try {
		const client = await daemonClientForProject(input.cwd);
		const response = await client.request({ op: "stop", name: input.name, id: input.id, timeoutMs: 2000 });
		if (response.op !== "stop") throw new Error(`Unexpected daemon broker response: ${response.op}`);
		if (input.id !== undefined && response.daemon.id !== input.id)
			throw new Error("Background process was replaced; its replacement was not stopped");
	} finally {
		await closeDaemonClients();
	}
}

interface DesktopPluginPromptContribution {text?:string;skills?:string[];tools?:string[]}

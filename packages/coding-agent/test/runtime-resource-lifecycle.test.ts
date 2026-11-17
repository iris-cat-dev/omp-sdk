import { afterEach, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeInVmContext } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getCompletionHandle, retainCompletionHandle } from "../src/eval/completion-bridge";

const sessions: AgentSession[] = [];
const roots: TempDir[] = [];
const authStores: AuthStorage[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	for (const auth of authStores.splice(0)) auth.close();
	for (const root of roots.splice(0)) root.removeSync();
});

async function createSession(kernelMode: "session" | "per-call" = "session") {
	const root = TempDir.createSync("@pi-runtime-resource-");
	roots.push(root);
	const auth = await AuthStorage.create(":memory:");
	authStores.push(auth);
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const python = Bun.which(process.env.OMP_TEST_PYTHON ?? "python3");
	if (!python) throw new Error("Python is required for the runtime resource lifecycle test");
	const settings = Settings.isolated({
		"python.kernelMode": kernelMode,
		"python.interpreter": python,
	});
	const manager = SessionManager.create(root.path(), path.join(root.path(), "sessions"));
	const session = new AgentSession({
		agent: new Agent({ initialState: { model, tools: [], messages: [], systemPrompt: [] } }),
		sessionManager: manager,
		settings,
		modelRegistry: new ModelRegistry(auth),
	});
	sessions.push(session);
	return { session, manager, root, settings };
}

it("retains Python variables while idle, releases only the selected real subprocess, and does not affect another session", async () => {
	const one = await createSession();
	const two = await createSession();
	expect((await one.session.executePython("marker = 41")).exitCode).toBe(0);
	expect((await two.session.executePython("marker = 99")).exitCode).toBe(0);
	const resource = (await one.session.getRuntimeResources()).find(item => item.kind === "python_kernel");
	if (!resource?.pid) throw new Error("Expected real retained Python subprocess");
	expect(resource.state).toBe("retained");
	expect(resource.releasable).toBe(true);
	expect((await one.session.executePython("print(marker + 1)")).output).toContain("42");
	await one.session.releaseRuntimeResource(resource.id);
	expect(() => process.kill(resource.pid!, 0)).toThrow();
	expect((await one.session.getRuntimeResources()).some(item => item.id === resource.id)).toBe(false);
	expect((await one.session.executePython("print('marker' in globals())")).output).toContain("False");
	expect((await two.session.executePython("print(marker)")).output).toContain("99");
}, 60_000);

it("keeps shell, Python and JavaScript state usable across a real branch, then releases each resource explicitly", async () => {
	const { session, manager, root, settings } = await createSession();
	const user = { role: "user" as const, content: "branch target", timestamp: Date.now() };
	const entryId = manager.appendMessage(user);
	session.agent.appendMessage(user);
	expect((await session.executeBash("export OMP_RESOURCE_MARKER=kept")).exitCode).toBe(0);
	expect((await session.executePython("marker = 42")).exitCode).toBe(0);
	const evalTool = new EvalTool({
		cwd: root.path(),
		hasUI: false,
		settings,
		getSessionFile: () => manager.getSessionFile() ?? null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => session.getEvalSessionId(),
		getEvalKernelOwnerId: () => session.getEvalKernelOwnerId(),
		trackEvalExecution: (execution, controller) => session.trackEvalExecution(execution, controller),
	});
	expect(
		(await evalTool.execute("branch-js-create", { language: "js", code: "var marker = 42; print(marker);" })).details
			?.cells?.[0]?.output,
	).toContain("42");
	const before = await session.getRuntimeResources();
	const shell = before.find(item => item.kind === "shell");
	const kernel = before.find(item => item.kind === "python_kernel");
	const javascript = before.find(item => item.kind === "javascript_kernel");
	if (!javascript?.pid) throw new Error("Expected a real retained JavaScript subprocess");
	const transcriptId = session.sessionId;
	if (!shell || !kernel?.pid) throw new Error("Expected owned shell and real Python kernel");
	expect((await session.branch(entryId)).cancelled).toBe(false);
	expect(session.sessionId).not.toBe(transcriptId);
	const after = await session.getRuntimeResources();
	expect(after.some(item => item.id === shell.id)).toBe(true);
	expect(after.some(item => item.id === kernel.id)).toBe(true);
	expect(after.some(item => item.id === javascript.id)).toBe(true);
	expect((await session.executePython("print(marker)")).output).toContain("42");
	expect(
		(await evalTool.execute("branch-js-read", { language: "js", code: "print(marker);" })).details?.cells?.[0]
			?.output,
	).toContain("42");
	const afterRead = await session.getRuntimeResources();
	expect(afterRead.find(item => item.id === kernel.id)?.pid).toBe(kernel.pid);
	expect(afterRead.find(item => item.id === javascript.id)?.pid).toBe(javascript.pid);
	expect(afterRead.filter(item => item.kind.endsWith("_kernel"))).toHaveLength(2);
	expect((await session.executeBash("printf '%s\\n' \"$OMP_RESOURCE_MARKER\"")).output).toContain("kept");
	await session.releaseRuntimeResource(shell.id);
	expect((await session.executeBash("printf '%s\\n' \"${OMP_RESOURCE_MARKER-unset}\"")).output).toContain("unset");
	await session.releaseRuntimeResource(kernel.id);
	expect(() => process.kill(kernel.pid!, 0)).toThrow();
	expect((await session.executePython("print('marker' in globals())")).output).toContain("False");
	await session.releaseRuntimeResource(javascript.id);
	expect(() => process.kill(javascript.pid!, 0)).toThrow();
	expect(
		(await evalTool.execute("branch-js-missing", { language: "js", code: "print(typeof marker);" })).details
			?.cells?.[0]?.output,
	).toContain("undefined");
}, 60_000);

it("releases a real JavaScript subprocess, clears its variables and preserves an unrelated kernel", async () => {
	const one = await createSession();
	const two = await createSession();
	async function execute(target: typeof one, code: string) {
		const toolSession: ToolSession = {
			cwd: target.root.path(),
			hasUI: false,
			settings: target.settings,
			getSessionFile: () => target.manager.getSessionFile() ?? null,
			getSessionSpawns: () => null,
		};
		let output = "";
		await executeInVmContext({
			sessionKey: target.session.getEvalKernelOwnerId(),
			sessionId: target.session.sessionId,
			ownerId: target.session.getEvalKernelOwnerId(),
			cwd: target.root.path(),
			session: toolSession,
			code,
			filename: "resource-test.js",
			timeoutMs: 15_000,
			runState: {
				onText: chunk => {
					output += chunk;
				},
			},
		});
		return output;
	}
	await execute(one, "var marker = 42");
	await execute(two, "var marker = 99");
	const resource = (await one.session.getRuntimeResources()).find(item => item.kind === "javascript_kernel");
	if (!resource?.pid) throw new Error("Expected real isolated JavaScript subprocess, not worker fallback");
	expect(await execute(one, "print(marker)")).toContain("42");
	await one.session.releaseRuntimeResource(resource.id);
	expect(() => process.kill(resource.pid!, 0)).toThrow();
	expect(await execute(one, "print(typeof marker)")).toContain("undefined");
	expect(await execute(two, "print(marker)")).toContain("99");
}, 60_000);

it("reports an in-flight native shell without waiting for its run lock and refuses release", async () => {
	const { session } = await createSession();
	const ready = Promise.withResolvers<void>();
	const running = session.executeBash("sh -c 'printf \"shell-resource-ready\\n\"; sleep 20'", chunk => {
		if (chunk.includes("shell-resource-ready")) ready.resolve();
	});
	let deadline: NodeJS.Timeout | undefined;
	let pid: number | undefined;
	try {
		await ready.promise;
		// A real Rust session mutex and child process cannot be driven by JavaScript fake timers.
		const timedOut = Promise.withResolvers<never>();
		deadline = setTimeout(() => timedOut.reject(new Error("Inventory waited for the active native shell")), 2_000);
		const resources = await Promise.race([session.getRuntimeResources(), timedOut.promise]);
		const shell = resources.find(item => item.kind === "shell");
		if (!shell?.pid) throw new Error("Expected the real in-flight shell child PID");
		pid = shell.pid;
		expect(shell).toMatchObject({ state: "running", releasable: false });
		expect(shell.retentionReasons).toContain("live_execution");
		expect(shell.liveHandles).toBeGreaterThan(0);
		await expect(session.releaseRuntimeResource(shell.id)).rejects.toThrow("live work");
	} finally {
		clearTimeout(deadline);
		session.abortBash();
		await running;
	}
	await session.dispose();
	if (pid) expect(() => process.kill(pid!, 0)).toThrow();
}, 60_000);

it("refuses release while real Python work is active and reclaims every subprocess after session disposal", async () => {
	for (let cycle = 0; cycle < 3; cycle++) {
		const { session } = await createSession();
		await session.executePython("marker = 42");
		const resource = (await session.getRuntimeResources()).find(item => item.kind === "python_kernel");
		if (!resource?.pid) throw new Error("Expected a real Python subprocess");
		const ready = Promise.withResolvers<void>();
		const running = session.executePython(
			"import time\nprint('resource-ready', flush=True)\ntime.sleep(20)",
			chunk => {
				if (chunk.includes("resource-ready")) ready.resolve();
			},
		);
		try {
			await ready.promise;
			expect((await session.getRuntimeResources()).find(item => item.id === resource.id)?.releasable).toBe(false);
			await expect(session.releaseRuntimeResource(resource.id)).rejects.toThrow("live work");
		} finally {
			session.abortEval();
			await running;
		}
		await session.dispose();
		expect(() => process.kill(resource.pid!, 0)).toThrow();
		expect(await session.getRuntimeResources()).toEqual([]);
	}
}, 90_000);

it("keeps a live helper owned until request settlement, waits during disposal, and leaves a different owner untouched", async () => {
	const one = await createSession();
	const two = await createSession();
	function helperSession(target: typeof one, agentId: string): ToolSession {
		return {
			cwd: target.root.path(),
			hasUI: false,
			settings: target.settings,
			getSessionFile: () => target.manager.getSessionFile() ?? null,
			getSessionSpawns: () => null,
			getEvalKernelOwnerId: () => target.session.getEvalKernelOwnerId(),
			getSessionId: () => target.session.sessionId,
			getAgentId: () => agentId,
		};
	}
	const started = Promise.withResolvers<void>();
	const aborted = Promise.withResolvers<void>();
	const complete = Promise.withResolvers<void>();
	const first = retainCompletionHandle("resource", { session: helperSession(one, "resource-one") }, async signal => {
		signal.addEventListener("abort", () => aborted.resolve(), { once: true });
		started.resolve();
		await complete.promise;
		if (signal.aborted) throw signal.reason;
		return { text: "first", details: { model: "local-lifecycle-request", structured: false } };
	});
	const second = retainCompletionHandle("resource", { session: helperSession(two, "resource-two") }, async () => ({
		text: "second",
		details: { model: "local-lifecycle-request", structured: false },
	}));
	let disposing: Promise<void> | undefined;
	try {
		await started.promise;
		await getCompletionHandle(second.id)?.promise;
		const resource = (await one.session.getRuntimeResources()).find(item => item.id === first.id);
		expect(resource).toMatchObject({
			kind: "helper",
			ownerAgentId: "resource-one",
			state: "running",
			releasable: false,
			liveHandles: 1,
		});
		await expect(one.session.releaseRuntimeResource(first.id)).rejects.toThrow("live work");
		let disposed = false;
		disposing = one.session.dispose().then(() => {
			disposed = true;
		});
		await aborted.promise;
		expect(disposed).toBe(false);
		expect(getCompletionHandle(first.id)).toBeDefined();
		complete.resolve();
		await disposing;
		expect(getCompletionHandle(first.id)).toBeUndefined();
		expect((await two.session.getRuntimeResources()).find(item => item.id === second.id)).toMatchObject({
			state: "retained",
			releasable: true,
		});
		await two.session.releaseRuntimeResource(second.id);
		expect(getCompletionHandle(second.id)).toBeUndefined();
	} finally {
		complete.resolve();
		await disposing;
	}
}, 60_000);

it("audits and reclaims a real per-call Python kernel instead of dropping its shutdown receipt", async () => {
	const { session } = await createSession("per-call");
	const ready = Promise.withResolvers<void>();
	const running = session.executePython("import time\nprint('per-call-ready', flush=True)\ntime.sleep(20)", chunk => {
		if (chunk.includes("per-call-ready")) ready.resolve();
	});
	let pid: number | undefined;
	try {
		await ready.promise;
		const resource = (await session.getRuntimeResources()).find(item => item.kind === "python_kernel");
		pid = resource?.pid;
		expect(resource).toMatchObject({ state: "running", releasable: false });
		expect(pid).toBeGreaterThan(0);
		if (!resource) throw new Error("Expected a real per-call Python kernel");
		await expect(session.releaseRuntimeResource(resource.id)).rejects.toThrow("live work");
	} finally {
		session.abortEval();
		await running;
	}
	expect(() => process.kill(pid!, 0)).toThrow();
	expect(await session.getRuntimeResources()).toEqual([]);
}, 60_000);

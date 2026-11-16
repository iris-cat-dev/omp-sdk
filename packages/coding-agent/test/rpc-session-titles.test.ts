import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcSessionTitles } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-titles";
import type { RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { SessionInfoUpdateEvent } from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { readLines, removeWithRetries } from "@oh-my-pi/pi-utils";

const AUTO_TITLE = "🧪 FLAKY: Fix flaky park tests";
type Frame = Record<string, unknown>;
const children: Array<Bun.Subprocess<"pipe", "pipe", "pipe">> = [];
let root: string | undefined;

afterEach(async () => {
	for (const child of children.splice(0)) {
		child.kill();
		await child.exited;
	}
	if (root) await removeWithRetries(root);
	root = undefined;
});

async function start(autoTitle = false, saved?: string) {
	root ??= await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-titles-"));
	const child = Bun.spawn([
		process.execPath,
		path.join(import.meta.dir, "fixtures", "session-title-rpc-agent.ts"),
		root,
		autoTitle ? "auto" : "off",
		...(saved ? [saved] : []),
	], {
		cwd: root,
		env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: root, PI_PROFILE: "" },
		stdin: "pipe", stdout: "pipe", stderr: "pipe",
	});
	children.push(child);
	const stderr = new Response(child.stderr).text();
	const lines = readLines(child.stdout, AbortSignal.timeout(30_000));
	const decoder = new TextDecoder();
	const seen: Frame[] = [];
	const receive = async (): Promise<Frame> => {
		const line = await lines.next();
		if (line.done) throw new Error(`RPC fixture exited: ${await stderr}`);
		const frame = JSON.parse(decoder.decode(line.value)) as Frame;
		seen.push(frame);
		return frame;
	};
	const waitFor = async (match: (frame: Frame) => boolean): Promise<Frame> => {
		const prior = seen.find(match);
		if (prior) return prior;
		for (;;) {
			const frame = await receive();
			if (match(frame)) return frame;
		}
	};
	let sequence = 0;
	const command = async (fields: object): Promise<Frame> => {
		const id = String(++sequence);
		child.stdin.write(`${JSON.stringify({ ...fields, id })}\n`);
		await child.stdin.flush();
		const response = await waitFor(frame => frame.type === "response" && frame.id === id);
		expect(response.success).toBe(true);
		return response;
	};
	const state = async (): Promise<RpcSessionState> => (await command({ type: "get_state" })).data as RpcSessionState;
	const titles = (): Frame[] => seen.filter(frame => frame.type === "session_info_update");
	const prompt = async (message: string): Promise<void> => {
		const response = await command({ type: "prompt", message });
		const result = await waitFor(frame => frame.type === "prompt_result" && frame.id === response.id);
		expect(result.status).toBe("completed");
	};
	const close = async (): Promise<void> => {
		child.stdin.end();
		expect(await child.exited).toBe(0);
		children.splice(children.indexOf(child), 1);
	};
	await waitFor(frame => frame.type === "ready");
	await state();
	return { command, state, titles, prompt, waitFor, seen, close };
}

describe("native session titles over RPC", () => {
	test("default RPC stays unnamed; explicit and slash renames each publish exactly once", async () => {
		const rpc = await start();
		await rpc.prompt("fix the flaky park tests");
		const initial = await rpc.state();
		expect(initial.sessionName).toBeUndefined();
		expect(initial.titleSource).toBeUndefined();
		expect(rpc.titles().filter(frame => frame.title !== undefined)).toEqual([]);

		rpc.seen.length = 0;
		await rpc.command({ type: "set_session_name", name: "  My park tests  " });
		expect(await rpc.state()).toMatchObject({ sessionName: "My park tests", titleSource: "user" });
		expect(rpc.titles()).toEqual([
			{ type: "session_info_update", sessionId: initial.sessionId, title: "My park tests", titleSource: "user" },
		]);

		rpc.seen.length = 0;
		const renamed = await rpc.command({ type: "prompt", message: "/rename My own workspace title" });
		// Locally consumed builtins acknowledge completion in the response, without a prompt_result.
		expect(renamed.data).toEqual({ agentInvoked: false });
		expect(await rpc.state()).toMatchObject({
			sessionName: "My own workspace title", titleSource: "user", messageCount: initial.messageCount,
		});
		expect(rpc.seen.some(frame => frame.type === "prompt_result" && frame.id === renamed.id)).toBe(false);
		expect(rpc.titles()).toEqual([
			{ type: "session_info_update", sessionId: initial.sessionId, title: "My own workspace title", titleSource: "user" },
		]);
	}, 30_000);

	test("opted-in auto titles bypass event filters and restored user titles publish without a turn", async () => {
		const rpc = await start(true);
		await rpc.command({ type: "set_event_filter", events: [] });
		await rpc.prompt("fix the flaky park tests");
		const event = await rpc.waitFor(frame => frame.type === "session_info_update" && frame.titleSource === "auto");
		expect(event.title).toBe(AUTO_TITLE);
		const named = await rpc.state();
		expect(named).toMatchObject({ sessionName: AUTO_TITLE, titleSource: "auto" });

		await rpc.command({ type: "set_session_name", name: "Keep my title" });
		const manual = await rpc.state();
		expect(manual).toMatchObject({ sessionName: "Keep my title", titleSource: "user" });
		if (!manual.sessionFile) throw new Error("Expected persisted session");
		await rpc.close();

		const resumed = await start(true, manual.sessionFile);
		expect(await resumed.state()).toMatchObject({
			sessionId: manual.sessionId, sessionName: "Keep my title", titleSource: "user", messageCount: manual.messageCount,
		});
		expect(resumed.titles()).toEqual([
			{ type: "session_info_update", sessionId: manual.sessionId, title: "Keep my title", titleSource: "user" },
		]);
		await resumed.prompt("fix another set of park tests");
		expect(await resumed.state()).toMatchObject({ sessionName: "Keep my title", titleSource: "user" });
		expect(resumed.titles()).toHaveLength(1);
	}, 30_000);

	test("new and switched sessions publish their own identities without accumulating listeners", async () => {
		const rpc = await start(true);
		await rpc.command({ type: "set_session_name", name: "Saved manual title" });
		const original = await rpc.state();
		if (!original.sessionFile) throw new Error("Expected persisted session");

		rpc.seen.length = 0;
		await rpc.command({ type: "new_session" });
		const fresh = await rpc.state();
		expect(fresh.sessionId).not.toBe(original.sessionId);
		expect(rpc.titles()).toEqual([{ type: "session_info_update", sessionId: fresh.sessionId }]);
		await rpc.prompt("fix the flaky park tests");
		await rpc.waitFor(frame => frame.type === "session_info_update" && frame.titleSource === "auto");
		expect(await rpc.state()).toMatchObject({ sessionId: fresh.sessionId, sessionName: AUTO_TITLE, titleSource: "auto" });

		rpc.seen.length = 0;
		await rpc.command({ type: "switch_session", sessionPath: original.sessionFile });
		expect(await rpc.state()).toMatchObject({ sessionId: original.sessionId, sessionName: "Saved manual title", titleSource: "user" });
		await rpc.command({ type: "set_session_name", name: "Renamed after switch" });
		expect(rpc.titles()).toEqual([
			{ type: "session_info_update", sessionId: original.sessionId, title: "Saved manual title", titleSource: "user" },
			{ type: "session_info_update", sessionId: original.sessionId, title: "Renamed after switch", titleSource: "user" },
		]);
	}, 30_000);
});

describe("RpcSessionTitles native source and lifetime", () => {
	test("user source rejects later auto updates and disposing detaches name notifications", async () => {
		const manager = SessionManager.inMemory();
		const frames: SessionInfoUpdateEvent[] = [];
		const titles = new RpcSessionTitles({ sessionManager: manager }, frame => frames.push(frame));
		try {
			frames.length = 0;
			expect(await manager.setSessionName("Native auto title", "auto")).toBe(true);
			expect(await manager.setSessionName("Native auto title", "user")).toBe(true);
			// A source-only change still reaches consumers, even though its text is unchanged.
			expect(frames.map(frame => frame.titleSource)).toEqual(["auto", "user"]);
			expect(await manager.setSessionName("Late generated title", "auto")).toBe(false);
			titles.refresh();
			expect(frames).toHaveLength(2);
			expect(manager.getSessionName()).toBe("Native auto title");
			titles.dispose();
			expect(await manager.setSessionName("Manual after disposal", "user")).toBe(true);
			titles.refresh();
			expect(frames).toHaveLength(2);
		} finally {
			titles.dispose();
			await manager.close();
		}
	});
});

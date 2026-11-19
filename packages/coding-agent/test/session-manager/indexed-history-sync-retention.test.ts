import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	IndexedSessionJournal,
	SessionEntryBodyCache,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-journal";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const ENTRY_COUNT = 1520;
const BODY_BYTES = 400 * 1024;

function content(entry: SessionMessageEntry) {
	if (entry.message.role !== "user" || !Array.isArray(entry.message.content)) throw new Error("Expected user blocks");
	return entry.message.content;
}

function consume(entry: SessionMessageEntry): string {
	const block = content(entry)[0];
	if (block?.type !== "text") throw new Error("Expected historical text");
	return createHash("sha256").update(block.text).digest("hex");
}

it("bounds a consuming synchronous job and keeps evicted nested views coherent through persistence", async () => {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-indexed-sync-retention-"));
	const file = path.join(directory, "history.jsonl");
	const digests: string[] = [];
	let manager: SessionManager | undefined;
	try {
		const writer = await fs.promises.open(file, "w");
		try {
			await writer.write(
				`${JSON.stringify({ type: "session", version: 3, id: "sync-retention", timestamp: "2026-01-01T00:00:00Z", cwd: directory })}\n`,
			);
			let parentId: string | null = null;
			for (let index = 0; index < ENTRY_COUNT; index++) {
				const id = `old-${index}`;
				const text = `${index}:`.padEnd(BODY_BYTES, "x");
				digests.push(createHash("sha256").update(text).digest("hex"));
				await writer.write(
					`${JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", timestamp: index, content: [{ type: "text", text }] } })}\n`,
				);
				parentId = id;
			}
			await writer.write(
				`${JSON.stringify({ type: "message", id: "kept", parentId, timestamp: "2026-01-01T00:00:02Z", message: { role: "user", timestamp: ENTRY_COUNT, content: "kept prompt" } })}\n`,
			);
			await writer.write(
				`${JSON.stringify({ type: "compaction", id: "compact", parentId: "kept", timestamp: "2026-01-01T00:00:03Z", summary: "summary", firstKeptEntryId: "kept", tokensBefore: 90000 })}\n`,
			);
		} finally {
			await writer.close();
		}

		manager = await SessionManager.open(file, directory, undefined, { suppressBreadcrumb: true });
		const firstEntry = manager.getEntry("old-0");
		if (firstEntry?.type !== "message") throw new Error("Expected historical entry");
		const first = content(firstEntry);
		const firstBlock = first[0];
		if (firstBlock?.type !== "text") throw new Error("Expected borrowed text block");
		const treeEntry = manager.getTree()[0]!.entry;
		Bun.gc(true);
		const baselineHeap = process.memoryUsage().heapUsed;
		let consumed = 0;
		// Deliberately one job: no await, yield, retained payloads, or WeakRefs to
		// observed bodies. Even the consumer hashes and drops its text immediately.
		for (const entry of manager.getEntries()) {
			if (entry.type !== "message" || !entry.id.startsWith("old-")) continue;
			expect(consume(entry)).toBe(digests[consumed]);
			consumed++;
			if (consumed % 160 === 0) {
				Bun.gc(true);
				const stats = manager.getHistoryRetentionStats();
				expect(stats.residentBodyBytes).toBeLessThanOrEqual(stats.maxBytes);
				expect(stats.pinnedBodyBytes).toBe(0);
				expect(stats.borrowedBodyBytes).toBe(0);
				// Independently observe the live heap; changing accounting alone must
				// not turn the former hundreds-of-MiB retention into a passing test.
				expect(process.memoryUsage().heapUsed - baselineHeap).toBeLessThan(96 * 1024 * 1024);
			}
		}
		expect(consumed).toBe(ENTRY_COUNT);
		expect(manager.getHistoryRetentionStats().borrowedEntries).toBeGreaterThan(0);
		const second = content(firstEntry);
		expect(second).toBe(first);
		expect(second[0]).toBe(firstBlock);
		if (treeEntry.type !== "message") throw new Error("Expected held tree message");
		expect(content(treeEntry)).toBe(first);

		// The old block and a separately acquired array must edit one current
		// body, not resurrect two evicted copies that overwrite each other.
		const amended = `amended-${"z".repeat(5 * 1024 * 1024)}`;
		firstBlock.text = amended;
		second.push({ type: "text", text: "second borrowed edit" });
		expect(consume(firstEntry)).toBe(createHash("sha256").update(amended).digest("hex"));
		const pending = manager.getHistoryRetentionStats();
		expect(pending.pinnedBodyBytes).toBeGreaterThan(8 * 1024 * 1024);
		expect(pending.borrowedBodyBytes).toBe(0);
		manager.flushSync();
		expect(manager.getHistoryRetentionStats().pinnedBodyBytes).toBe(0);
		expect(content(firstEntry)).toBe(first);
		expect(first[0]).toBe(firstBlock);

		const reopened = await SessionManager.open(file, directory, undefined, { suppressBreadcrumb: true });
		try {
			const restored = reopened.getEntry("old-0");
			if (restored?.type !== "message") throw new Error("Expected durable edited entry");
			expect(content(restored)).toEqual([
				{ type: "text", text: amended },
				{ type: "text", text: "second borrowed edit" },
			]);
		} finally {
			await reopened.close();
		}
	} finally {
		await manager?.close();
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
}, 120_000);

it("keeps a dropped fork view readable but rejects rewritten, misidentified, or truncated source bytes", async () => {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-indexed-source-version-"));
	const file = path.join(directory, "source.jsonl");
	const fork = path.join(directory, "fork.jsonl");
	try {
		const header = `${JSON.stringify({ type: "session", version: 3, id: "source-version", timestamp: "2026-01-01T00:00:00Z", cwd: directory })}\n`;
		const line = `${JSON.stringify({ type: "message", id: "old-0", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", timestamp: 0, content: [{ type: "text", text: "original" }] } })}\n`;
		await fs.promises.writeFile(file, header + line);
		await fs.promises.writeFile(fork, header + line.replace("old-0", "new-0"));
		const journal = await IndexedSessionJournal.open(file);
		const reference = journal.get("old-0")!;
		const cache = new SessionEntryBodyCache(journal, () => {}, 0);
		const entry = cache.makeCold(journal.readEntrySync(reference), reference);
		if (entry.type !== "message") throw new Error("Expected historical message");
		const held = content(entry)[0];
		if (held?.type !== "text") throw new Error("Expected historical block");
		journal.invalidate(fork);
		journal.refreshSync();
		cache.commit();
		const beforeFallback = journal.getStats();
		expect(held.text).toBe("original");
		expect(journal.getStats().entryBytesRead - beforeFallback.entryBytesRead).toBe(reference.length);
		expect(journal.getStats().entryEntriesParsed - beforeFallback.entryEntriesParsed).toBe(1);
		expect(cache.getStats().residentBodyBytes).toBe(0);

		const replacement = path.join(directory, "replacement.jsonl");
		await fs.promises.writeFile(replacement, header + line.replace("original", "replaced"));
		await fs.promises.rename(replacement, file);
		const beforeRewrite = journal.getStats();
		expect(() => held.text).toThrow("source version is stale");
		expect(journal.getStats().entryBytesRead - beforeRewrite.entryBytesRead).toBe(reference.length);
		expect(journal.getStats().entryEntriesParsed - beforeRewrite.entryEntriesParsed).toBe(1);

		await fs.promises.writeFile(file, header + line.replace("old-0", "bad-0"));
		expect(() => held.text).toThrow("index is stale");
		const remainingBytes = Math.floor(reference.length / 2);
		await fs.promises.truncate(file, reference.offset + remainingBytes);
		const beforeTruncate = journal.getStats();
		expect(() => held.text).toThrow("was truncated");
		expect(journal.getStats().entryBytesRead - beforeTruncate.entryBytesRead).toBe(remainingBytes);
		expect(journal.getStats().entryEntriesParsed).toBe(beforeTruncate.entryEntriesParsed);
	} finally {
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
});

it("caches an oversized cold entry transiently across interleaved synchronous scans and releases it after the microtask", async () => {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-indexed-oversized-"));
	const file = path.join(directory, "oversized.jsonl");
	try {
		const header = `${JSON.stringify({ type: "session", version: 3, id: "oversized", timestamp: "2026-01-01T00:00:00Z", cwd: directory })}\n`;
		const toolCallCount = 40;
		const assistantEntry: SessionMessageEntry = {
			type: "message",
			id: "big-assistant",
			parentId: null,
			timestamp: "2026-01-01T00:00:01Z",
			message: {
				role: "assistant",
				api: "cursor-agent",
				provider: "cursor",
				model: "gemini-4-neon",
				stopReason: "stop",
				timestamp: 1,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				content: Array.from({ length: toolCallCount }, (_, index) => ({
					type: "toolCall" as const,
					id: `call-${index}`,
					name: "read",
					arguments: { path: `src/file-${index}.ts` },
				})),
				// Large enough that UTF-16 estimate exceeds the 64 KiB cache budget below.
				providerPayload: {
					type: "cursorHistory",
					wireRoute: '["gemini-4-neon"]',
					digest: "digest",
					records: ["r".repeat(96 * 1024)],
				},
			},
		};
		const toolResults: SessionMessageEntry[] = Array.from({ length: toolCallCount }, (_, index) => ({
			type: "message",
			id: `res-${index}`,
			parentId: index === 0 ? "big-assistant" : `res-${index - 1}`,
			timestamp: "2026-01-01T00:00:02Z",
			message: {
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "read",
				content: [{ type: "text", text: `output-${index}` }],
				isError: false,
				timestamp: 2 + index,
			},
		}));
		await fs.promises.writeFile(
			file,
			header + [assistantEntry, ...toolResults].map(entry => `${JSON.stringify(entry)}\n`).join(""),
		);

		const journal = await IndexedSessionJournal.open(file);
		const cache = new SessionEntryBodyCache(journal, () => {}, 64 * 1024);
		const coldEntries = journal.entries.map(ref =>
			cache.makeCold({ ...ref.metadata } as unknown as SessionMessageEntry, ref),
		);
		const coldAssistant = coldEntries[0] as SessionMessageEntry;
		const coldResults = coldEntries.slice(1) as SessionMessageEntry[];

		const before = journal.getStats();
		// Interleave reading every toolCall on the oversized assistant with every small toolResult.
		const calls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
		if (coldAssistant.message.role !== "assistant") throw new Error("Expected assistant");
		for (const block of coldAssistant.message.content) {
			if (block.type === "toolCall") calls.set(block.id, block);
		}
		for (const resultEntry of coldResults) {
			if (resultEntry.message.role !== "toolResult") continue;
			const paired = calls.get(resultEntry.message.toolCallId);
			expect(paired?.name).toBe("read");
			expect(paired?.arguments.path).toBe(`src/file-${resultEntry.message.toolCallId.slice(5)}.ts`);
			expect(resultEntry.message.content[0]).toMatchObject({ type: "text" });
		}
		const after = journal.getStats();
		// 1 read for the oversized assistant + 40 reads for the 40 distinct toolResults — never self-evicted.
		expect(after.entryEntriesParsed - before.entryEntriesParsed).toBe(1 + toolCallCount);

		// A same-tick commit() followed by another oversized read must still drain at the microtask boundary.
		cache.commit();
		void coldAssistant.message.content.length;
		expect(cache.getStats().residentBodyBytes).toBeGreaterThan(64 * 1024);
		await Promise.resolve();
		expect(cache.getStats().residentBodyBytes).toBeLessThanOrEqual(64 * 1024);
		expect(cache.getStats().overBudgetBytes).toBe(0);
	} finally {
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
});

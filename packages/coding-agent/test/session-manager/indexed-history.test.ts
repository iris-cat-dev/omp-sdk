import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IndexedSessionJournal } from "@oh-my-pi/pi-coding-agent/session/indexed-session-journal";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, type WriteTextAtomicOptions } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { makeAssistantMessage } from "./helpers";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});
async function fixture(): Promise<{ directory: string; file: string }> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-indexed-history-"));
	directories.push(directory);
	const file = path.join(directory, "history.jsonl");
	const writer = await fs.open(file, "w");
	try {
		await writer.write(
			`${JSON.stringify({ type: "session", version: 3, id: "history", timestamp: "2026-01-01T00:00:00Z", cwd: directory })}\n`,
		);
		let parentId: string | null = null;
		for (let index = 0; index < 40; index++) {
			const id = `old-${index}`;
			await writer.write(
				`${JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", timestamp: index, content: `原始-${index}-${"x".repeat(400 * 1024)}` } })}\n`,
			);
			parentId = id;
		}
		await writer.write(
			`${JSON.stringify({ type: "message", id: "kept", parentId, timestamp: "2026-01-01T00:00:02Z", message: { role: "user", timestamp: 41, content: "retained prompt" } })}\n`,
		);
		await writer.write(
			`${JSON.stringify({ type: "compaction", id: "compact", parentId: "kept", timestamp: "2026-01-01T00:00:03Z", summary: "compact summary", firstKeptEntryId: "kept", tokensBefore: 90000 })}\n`,
		);
		await writer.write(
			`${JSON.stringify({ type: "message", id: "reply", parentId: "compact", timestamp: "2026-01-01T00:00:04Z", message: makeAssistantMessage() })}\n`,
		);
	} finally {
		await writer.close();
	}
	return { directory, file };
}

function textHash(content: unknown): string {
	if (typeof content !== "string") throw new Error("Expected text content");
	return createHash("sha256").update(content).digest("hex");
}

class PausedRewriteStorage extends FileSessionStorage {
	pauseNext = false;
	readonly staged = Promise.withResolvers<void>();
	readonly release = Promise.withResolvers<void>();
	override async writeLinesAtomic(
		file: string,
		lines: Iterable<string>,
		options?: WriteTextAtomicOptions,
	): Promise<void> {
		if (!this.pauseNext) return super.writeLinesAtomic(file, lines, options);
		this.pauseNext = false;
		const stagedLines = Array.from(lines);
		this.staged.resolve();
		await this.release.promise;
		await super.writeLinesAtomic(file, stagedLines, options);
	}
}

describe("indexed historical bodies", () => {
	it("reads only selected bodies after reopening the durable index", async () => {
		const { file } = await fixture();
		await IndexedSessionJournal.open(file);
		const journal = await IndexedSessionJournal.open(file);
		expect(journal.getStats().bytesRead).toBe(0);
		const reference = journal.get("old-19")!;
		const entry = await journal.readEntry(reference);
		if (entry.type !== "message" || entry.message.role !== "user") throw new Error("Expected historical user prompt");
		expect(entry.message.content).toBe(`原始-19-${"x".repeat(400 * 1024)}`);
		expect(journal.getStats().bytesRead).toBe(reference.length);
		expect(journal.getStats().entriesParsed).toBe(1);
		expect(journal.getStats().indexBytesRead).toBe(0);
		expect(journal.getStats().entryBytesRead).toBe(reference.length);
		expect(journal.getStats().entryEntriesParsed).toBe(1);
		expect(journal.getStats().residentBodyBytes).toBe(0);
	});

	it("keeps tree/navigation cheap while model context hydrates only the kept tail", async () => {
		const { directory, file } = await fixture();
		const manager = await SessionManager.open(file, directory, undefined, { suppressBreadcrumb: true });
		try {
			const before = manager.getHistoryRetentionStats();
			expect(manager.getEntries()).toHaveLength(43);
			expect(manager.getTree()[0]!.entry.id).toBe("old-0");
			expect(manager.getBranch()).toHaveLength(43);
			expect(manager.getHistoryRetentionStats().bytesRead).toBe(before.bytesRead);
			const context = manager.buildSessionContext();
			expect(
				context.messages.some(message => message.role === "user" && message.content === "retained prompt"),
			).toBe(true);
			expect(manager.getHistoryRetentionStats().bytesRead - before.bytesRead).toBeLessThan(4096);
			for (const entry of manager.getEntries())
				if (entry.type === "message" && entry.message.role === "user") void entry.message.content;
			const retained = manager.getHistoryRetentionStats();
			expect(retained.cachedBodyBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
			expect(retained.residentBodyBytes).toBeLessThanOrEqual(retained.maxBytes);
		} finally {
			await manager.close();
		}
	});

	it("preserves edits and held entry/tree objects across full fork and atomic rewrite", async () => {
		const { directory, file } = await fixture();
		await fs.appendFile(
			file,
			`${JSON.stringify({ type: "message", id: "held-side", parentId: "old-0", activeLeafId: "reply", timestamp: "2026-01-01T00:00:05Z", message: { role: "user", content: "held side-branch body", timestamp: 44 } })}\n`,
		);
		const manager = await SessionManager.open(file, directory, undefined, { suppressBreadcrumb: true });
		try {
			const entry = manager.getEntry("old-19")!;
			const treeEntry = manager.getTree()[0]!.entry;
			const heldSide = manager.getEntry("held-side")!;
			if (heldSide.type !== "message" || heldSide.message.role !== "user")
				throw new Error("Expected held off-branch entry");
			if (entry.type !== "message" || entry.message.role !== "user") throw new Error("Expected user entry");
			const amended = `amended-${"z".repeat(5 * 1024 * 1024)}`;
			const amendedHash = textHash(amended);
			entry.message.content = amended;
			expect(manager.getHistoryRetentionStats().pinnedBodyBytes).toBeGreaterThan(8 * 1024 * 1024);
			manager.flushSync();
			expect(manager.getHistoryRetentionStats().pinnedBodyBytes).toBe(0);
			const durableSource = await SessionManager.open(file, directory, undefined, { suppressBreadcrumb: true });
			try {
				const sourceEntry = durableSource.getEntry("old-19")!;
				if (sourceEntry.type !== "message" || sourceEntry.message.role !== "user")
					throw new Error("Expected durable amended user entry");
				expect(textHash(sourceEntry.message.content)).toBe(amendedHash);
			} finally {
				await durableSource.close();
			}
			const fork = manager.createBranchedSession("reply");
			expect(fork).not.toBe(file);
			expect(textHash(entry.message.content)).toBe(amendedHash);
			if (treeEntry.type !== "message" || treeEntry.message.role !== "user")
				throw new Error("Expected held tree entry");
			expect(treeEntry.message.content).toBe(`原始-0-${"x".repeat(400 * 1024)}`);
			expect(manager.getEntry("held-side")).toBeUndefined();
			expect(heldSide.message.content).toBe("held side-branch body");
			await manager.rewriteEntries();
			expect(textHash(entry.message.content)).toBe(amendedHash);
			expect(textHash(treeEntry.message.content)).toBe(textHash(`原始-0-${"x".repeat(400 * 1024)}`));
			expect(heldSide.message.content).toBe("held side-branch body");
			const reopened = await SessionManager.open(fork!, directory, undefined, { suppressBreadcrumb: true });
			try {
				const restored = reopened.getEntry("old-19")!;
				if (restored.type !== "message" || restored.message.role !== "user")
					throw new Error("Expected persisted amended entry");
				expect(textHash(restored.message.content)).toBe(amendedHash);
				expect(reopened.getEntry("held-side")).toBeUndefined();
			} finally {
				await reopened.close();
			}
		} finally {
			await manager.close();
		}
	});

	it("does not mint an empty owner when an auxiliary index operation reports ENOENT", async () => {
		const { directory, file } = await fixture();
		const before = await fs.readFile(file);
		const indexError = Object.assign(new Error("offset sidecar disappeared before publish"), {
			code: "ENOENT",
			path: `${file}.index.json.tmp`,
		});
		const open = spyOn(IndexedSessionJournal, "open").mockRejectedValueOnce(indexError);
		try {
			await expect(SessionManager.open(file, directory, undefined, { suppressBreadcrumb: true })).rejects.toThrow(
				indexError.message,
			);
			expect(await fs.readFile(file)).toEqual(before);
		} finally {
			open.mockRestore();
		}
		const manager = await SessionManager.open(file, directory, undefined, { suppressBreadcrumb: true });
		try {
			const entry = manager.getEntry("old-19")!;
			if (entry.type !== "message" || entry.message.role !== "user")
				throw new Error("Expected original durable user message");
			expect(entry.message.content).toBe(`原始-19-${"x".repeat(400 * 1024)}`);
		} finally {
			await manager.close();
		}
	});

	it("bounds hot retention by payload bytes rather than entry count", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hot-history-"));
		directories.push(directory);
		const manager = SessionManager.create(directory, directory);
		try {
			await manager.ensureOnDisk();
			const first = "a".repeat(3 * 1024 * 1024);
			const second = "b".repeat(5 * 1024 * 1024);
			const firstId = manager.appendMessage({ role: "user", timestamp: 1, content: first });
			const secondId = manager.appendMessage({ role: "user", timestamp: 2, content: second });
			const stats = manager.getHistoryRetentionStats();
			expect(stats.hotBodyBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
			expect(stats.residentBodyBytes).toBeLessThanOrEqual(stats.maxBytes);
			expect(manager.getEntries().filter(entry => entry.type === "message")).toHaveLength(2);
			const file = manager.getSessionFile();
			if (!file) throw new Error("Expected persisted full-body appends");
			const reopened = await SessionManager.open(file, directory, undefined, { suppressBreadcrumb: true });
			try {
				for (const [id, expected] of [
					[firstId, first],
					[secondId, second],
				] as const) {
					const entry = reopened.getEntry(id)!;
					if (entry.type !== "message" || entry.message.role !== "user")
						throw new Error("Expected full-body user append");
					expect(textHash(entry.message.content)).toBe(textHash(expected));
				}
			} finally {
				await reopened.close();
			}
		} finally {
			await manager.close();
		}
	});

	it("reuses a borrowed nested body after cache eviction and preserves both edits", async () => {
		const { directory, file } = await fixture();
		await fs.appendFile(
			file,
			`${JSON.stringify({ type: "message", id: "borrowed", parentId: "reply", timestamp: "2026-01-01T00:00:05Z", message: { role: "user", timestamp: 50, content: [{ type: "text", text: "original borrowed text" }] } })}\n`,
		);
		const manager = await SessionManager.open(file, directory, undefined, { suppressBreadcrumb: true });
		try {
			const entry = manager.getEntry("borrowed")!;
			if (entry.type !== "message" || entry.message.role !== "user" || !Array.isArray(entry.message.content))
				throw new Error("Expected borrowed user blocks");
			const first = entry.message.content;
			for (const old of manager.getEntries())
				if (old.id !== "borrowed" && old.type === "message" && old.message.role === "user")
					void old.message.content;
			expect(manager.getHistoryRetentionStats().borrowedEntries).toBeGreaterThan(0);
			const second = entry.message.content;
			expect(second).toBe(first);
			if (first[0]?.type !== "text") throw new Error("Expected borrowed text block");
			first[0].text = "first edit";
			second.push({ type: "text", text: "second edit" });
			manager.flushSync();
			const reopened = await SessionManager.open(file, directory, undefined, { suppressBreadcrumb: true });
			try {
				const persisted = reopened.getEntry("borrowed")!;
				if (persisted.type !== "message" || persisted.message.role !== "user")
					throw new Error("Expected persisted blocks");
				expect(persisted.message.content).toEqual([
					{ type: "text", text: "first edit" },
					{ type: "text", text: "second edit" },
				]);
			} finally {
				await reopened.close();
			}
		} finally {
			await manager.close();
		}
	});

	it("persists filtered cold arrays and nested borrowed blocks without recursive path facades", async () => {
		const { directory, file } = await fixture();
		await fs.appendFile(
			file,
			`${JSON.stringify({
				type: "custom_message",
				id: "filtered",
				parentId: "reply",
				timestamp: "2026-01-01T00:00:05Z",
				customType: "note",
				display: true,
				content: [
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
					{ type: "text", text: "retained first" },
					{ type: "text", text: "retained second" },
				],
				details: {},
			})}\n`,
		);
		const manager = await SessionManager.open(file, directory, undefined, { suppressBreadcrumb: true });
		try {
			const entry = manager.getEntry("filtered");
			if (entry?.type !== "custom_message" || !Array.isArray(entry.content))
				throw new Error("Expected cold custom content");
			entry.content = entry.content.filter(part => part.type !== "image");
			expect(entry.content).toEqual([
				{ type: "text", text: "retained first" },
				{ type: "text", text: "retained second" },
			]);
			expect("text" in entry.content[0]!).toBe(true);
			entry.details = { copied: { blocks: [entry.content[0]] } };
			const details = entry.details as Record<string, unknown>;
			details.assigned = { block: entry.content[1] };
			Object.defineProperty(details, "defined", {
				value: { block: entry.content[0] },
				enumerable: true,
				configurable: true,
				writable: true,
			});
			await manager.rewriteEntries();
			const reopened = await SessionManager.open(file, directory, undefined, { suppressBreadcrumb: true });
			try {
				const persisted = reopened.getEntry("filtered");
				if (persisted?.type !== "custom_message") throw new Error("Expected persisted custom content");
				expect(persisted.content).toEqual([
					{ type: "text", text: "retained first" },
					{ type: "text", text: "retained second" },
				]);
				expect(persisted.details).toEqual({
					copied: { blocks: [{ type: "text", text: "retained first" }] },
					assigned: { block: { type: "text", text: "retained second" } },
					defined: { block: { type: "text", text: "retained first" } },
				});
			} finally {
				await reopened.close();
			}
		} finally {
			await manager.close();
		}
	});

	it("persists a cold-body edit made after an atomic pass has serialized it", async () => {
		const { directory, file } = await fixture();
		const storage = new PausedRewriteStorage();
		const manager = await SessionManager.open(file, directory, storage, { suppressBreadcrumb: true });
		try {
			const entry = manager.getEntry("old-19")!;
			if (entry.type !== "message" || entry.message.role !== "user") throw new Error("Expected user entry");
			storage.pauseNext = true;
			const rewrite = manager.appendEntriesAtomically(() =>
				manager.appendMessage({ role: "user", timestamp: 60, content: "atomic tail" }),
			);
			await storage.staged.promise;
			entry.message.content = "edited while the first pass was staged";
			storage.release.resolve();
			await rewrite;
			expect(manager.getHistoryRetentionStats().pinnedBodyBytes).toBe(0);
			const reopened = await SessionManager.open(file, directory, undefined, { suppressBreadcrumb: true });
			try {
				const persisted = reopened.getEntry("old-19")!;
				if (persisted.type !== "message" || persisted.message.role !== "user")
					throw new Error("Expected persisted user entry");
				expect(persisted.message.content).toBe("edited while the first pass was staged");
			} finally {
				await reopened.close();
			}
		} finally {
			storage.release.resolve();
			await manager.close();
		}
	});

	it("tracks append and invalidates atomic replacement and truncation without stale offsets", async () => {
		const { file } = await fixture();
		const journal = await IndexedSessionJournal.open(file);
		const previous = journal.getStats();
		await fs.appendFile(
			file,
			`${JSON.stringify({ type: "message", id: "append", parentId: "reply", timestamp: "2026-01-01T00:00:05Z", message: { role: "user", timestamp: 50, content: "append prompt" } })}\n`,
		);
		await journal.refresh();
		expect(journal.getStats().entriesParsed - previous.entriesParsed).toBe(1);
		expect(journal.branch().at(-1)!.id).toBe("append");
		const oldReference = journal.get("old-0")!;
		const replacement = `${JSON.stringify({ type: "session", version: 3, id: "replacement", timestamp: "2026-01-01T00:00:00Z", cwd: path.dirname(file) })}\n${JSON.stringify({ type: "message", id: "old-0", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", timestamp: 1, content: "replacement prompt" } })}\n`;
		await fs.writeFile(`${file}.replace`, replacement);
		await fs.rename(`${file}.replace`, file);
		await journal.refresh();
		const replaced = await journal.readEntry(oldReference);
		if (replaced.type !== "message" || replaced.message.role !== "user") throw new Error("Expected replaced entry");
		expect(replaced.message.content).toBe("replacement prompt");
		await fs.truncate(file, 0);
		await journal.refresh();
		expect(journal.entries).toHaveLength(0);
		expect(journal.header).toBeUndefined();
	});
});

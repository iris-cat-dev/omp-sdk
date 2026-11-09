import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { FileEntry, SessionHeader } from "./session-entries";
import { parseTitleSlotLine, titleUpdateFromSlot, type SessionTitleUpdate } from "./session-title-slot";

/** Only bookkeeping and small replay settings live in this index, never journal bodies. */
export interface IndexedSessionEntry {
	id: string;
	parentId: string | null;
	type: string;
	offset: number;
	length: number;
	keys: string[];
	metadata: Record<string, unknown>;
	messageKeys?: string[];
	checksum: string;
	taskUsage?: { usage?: unknown };
}
export interface IndexedSessionJournalStats {
	bytesRead: number;
	entriesParsed: number;
	indexBytesRead: number;
	indexEntriesParsed: number;
	entryBytesRead: number;
	entryEntriesParsed: number;
	indexedEntries: number;
	residentBodyBytes: number;
}
interface JournalStamp {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}
interface JournalIndex {
	version: 1;
	stamp: JournalStamp;
	completeBytes: number;
	header?: SessionHeader;
	titleSlot?: SessionTitleUpdate;
	entries: IndexedSessionEntry[];
	malformedRecords: number;
	generation: string;
	projections: Record<string, unknown>;
	prefixHash: string;
	prefixBytes: number;
}
const PAYLOAD_KEYS: Record<string, true> = {
	message: true,
	content: true,
	details: true,
	summary: true,
	preserveData: true,
	data: true,
	output: true,
	extractedToolData: true,
};
const MESSAGE_METADATA = [
	"role",
	"api",
	"provider",
	"model",
	"timestamp",
	"usage",
	"toolCallId",
	"toolName",
	"isError",
	"stopReason",
	"responseId",
	"duration",
	"completedAt",
	"retryRecovery",
];
const CHUNK_BYTES = 256 * 1024;
function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stamp(stat: fs.Stats): JournalStamp {
	return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function same(a: JournalStamp, b: JournalStamp): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function small(value: unknown): boolean {
	return (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number" ||
		(typeof value === "string" && value.length <= 512)
	);
}
function reference(
	entry: Record<string, unknown>,
	offset: number,
	length: number,
	checksum: string,
): IndexedSessionEntry {
	const metadata: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entry)) {
		if (!PAYLOAD_KEYS[key] && (small(value) || key === "runtime" || key === "usage" || key === "injectedRules"))
			metadata[key] = value;
	}
	const message = entry.message;
	let messageKeys: string[] | undefined;
	if (record(message)) {
		messageKeys = Object.keys(message);
		const meta: Record<string, unknown> = {};
		for (const key of MESSAGE_METADATA) if (key in message) meta[key] = message[key];
		metadata.message = meta;
	}
	const taskUsage =
		record(message) && message.role === "toolResult" && message.toolName === "task"
			? { usage: record(message.details) ? message.details.usage : undefined }
			: undefined;
	return {
		id: entry.id as string,
		parentId: typeof entry.parentId === "string" ? entry.parentId : null,
		type: entry.type as string,
		offset,
		length,
		checksum,
		keys: Object.keys(entry),
		metadata,
		messageKeys,
		taskUsage,
	};
}

/** Shared SDK/daemon byte-offset journal. Sidecars are disposable, atomically replaced metadata. */
export class IndexedSessionJournal {
	filePath: string;
	#index!: JournalIndex;
	#byId = new Map<string, IndexedSessionEntry>();
	#bytesRead = 0;
	#entriesParsed = 0;
	#entryBytesRead = 0;
	#entryEntriesParsed = 0;
	#dirty = false;
	#revision = 0;
	#saveTail: Promise<void> = Promise.resolve();
	constructor(filePath: string) {
		this.filePath = path.resolve(filePath);
	}
	static async open(filePath: string): Promise<IndexedSessionJournal> {
		const journal = new IndexedSessionJournal(filePath);
		await journal.refresh();
		return journal;
	}
	invalidate(filePath = this.filePath): void {
		this.filePath = path.resolve(filePath);
		this.#index = undefined as unknown as JournalIndex;
		this.#dirty = true;
		this.#revision++;
	}
	get entries(): readonly IndexedSessionEntry[] {
		return this.#index.entries;
	}
	get header(): SessionHeader | undefined {
		return this.#index.header;
	}
	get titleSlot(): SessionTitleUpdate | undefined {
		return this.#index.titleSlot;
	}
	get sourceSize(): number {
		return this.#index.stamp.size;
	}
	get malformedRecords(): number {
		return this.#index.malformedRecords;
	}
	get generation(): string {
		return this.#index.generation;
	}
	get invalidHeader(): boolean {
		return !this.header && (this.entries.length > 0 || this.malformedRecords > 0);
	}
	getStats(): IndexedSessionJournalStats {
		return {
			bytesRead: this.#bytesRead,
			entriesParsed: this.#entriesParsed,
			indexBytesRead: this.#bytesRead - this.#entryBytesRead,
			indexEntriesParsed: this.#entriesParsed - this.#entryEntriesParsed,
			entryBytesRead: this.#entryBytesRead,
			entryEntriesParsed: this.#entryEntriesParsed,
			indexedEntries: this.entries.length,
			residentBodyBytes: 0,
		};
	}
	get(id: string): IndexedSessionEntry | undefined {
		return this.#byId.get(id);
	}
	branch(leafId?: string | null): IndexedSessionEntry[] {
		let replayed: string | null = null;
		let fallback: string | null = null;
		for (const entry of this.entries) {
			if (typeof entry.metadata.activeLeafId === "string") replayed = entry.metadata.activeLeafId;
			else if (entry.metadata.activeLeafId === null) replayed = null;
			else replayed = fallback = entry.id;
		}
		if (replayed !== null && !this.#byId.has(replayed)) replayed = fallback;
		let current = this.#byId.get(leafId === undefined ? (replayed ?? "") : (leafId ?? ""));
		const result: IndexedSessionEntry[] = [];
		const seen = new Set<string>();
		while (current && !seen.has(current.id)) {
			seen.add(current.id);
			result.push(current);
			current = current.parentId ? this.#byId.get(current.parentId) : undefined;
		}
		return result.reverse();
	}
	getProjection<T>(key: string): T | undefined {
		return this.#index.projections[key] as T | undefined;
	}
	setProjection(key: string, value: unknown): void {
		this.#index.projections[key] = value;
		this.#dirty = true;
		this.#revision++;
	}
	save(): Promise<void> {
		const operation = this.#saveTail.then(async () => {
			if (!this.#dirty) return;
			const revision = this.#revision;
			const destination = `${this.filePath}.index.json`;
			const temp = `${destination}.${process.pid}.${revision}.${randomUUID()}.tmp`;
			const content = JSON.stringify(this.#index);
			try {
				await fs.promises.writeFile(temp, content);
				await fs.promises.rename(temp, destination);
				if (revision === this.#revision) this.#dirty = false;
			} catch (error) {
				await fs.promises.rm(temp, { force: true });
				if (!["EACCES", "EROFS", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			}
		});
		this.#saveTail = operation.catch(() => {});
		return operation;
	}
	async refresh(): Promise<void> {
		if (!this.#index) {
			try {
				const cached: unknown = JSON.parse(await fs.promises.readFile(`${this.filePath}.index.json`, "utf8"));
				if (
					record(cached) &&
					cached.version === 1 &&
					record(cached.stamp) &&
					typeof cached.generation === "string" &&
					typeof cached.prefixHash === "string" &&
					typeof cached.prefixBytes === "number" &&
					Array.isArray(cached.entries) &&
					record(cached.projections) &&
					cached.entries.every(
						entry =>
							record(entry) &&
							typeof entry.id === "string" &&
							typeof entry.type === "string" &&
							typeof entry.checksum === "string" &&
							Number.isSafeInteger(entry.offset) &&
							Number.isSafeInteger(entry.length) &&
							(entry.offset as number) >= 0 &&
							(entry.length as number) > 0 &&
							Array.isArray(entry.keys) &&
							entry.keys.every(key => typeof key === "string") &&
							record(entry.metadata),
					)
				)
					this.#index = cached as unknown as JournalIndex;
			} catch (error) {
				if (
					!(error instanceof SyntaxError) &&
					!["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")
				)
					throw error;
			}
		}
		this.refreshSync();
		await this.save();
	}
	refreshSync(): void {
		const current = stamp(fs.statSync(this.filePath));
		if (this.#index && same(this.#index.stamp, current)) {
			if (this.#byId.size === 0) this.#rebuildLookup();
			return;
		}
		const previous = this.#index;
		// A size increase is append-only only if the old final record is unchanged.
		// Atomic replacement, truncation, title-slot edit, and in-place rewrite rebuild.
		const append =
			previous &&
			previous.stamp.dev === current.dev &&
			previous.stamp.ino === current.ino &&
			current.size > previous.stamp.size &&
			this.#prefixUnchanged(previous);
		if (!append)
			this.#index = {
				version: 1,
				stamp: current,
				completeBytes: 0,
				entries: [],
				malformedRecords: 0,
				generation: `${current.dev}:${current.ino}:${current.ctimeMs}`,
				projections: {},
				prefixHash: "",
				prefixBytes: 0,
			};
		const start = this.#index.completeBytes;
		const fd = fs.openSync(this.filePath, "r");
		try {
			const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
			let pending: Buffer[] = [];
			let pendingBytes = 0;
			let position = start;
			let recordStart = start;
			while (position < current.size) {
				const bytes = fs.readSync(fd, buffer, 0, Math.min(buffer.length, current.size - position), position);
				if (!bytes) break;
				this.#bytesRead += bytes;
				let from = 0;
				for (let index = 0; index < bytes; index++) {
					if (buffer[index] !== 10) continue;
					const part = buffer.subarray(from, index);
					const line = pendingBytes ? Buffer.concat([...pending, part], pendingBytes + part.length) : part;
					this.#consume(line, recordStart, position + index + 1 - recordStart);
					recordStart = position + index + 1;
					pending = [];
					pendingBytes = 0;
					from = index + 1;
				}
				if (from < bytes) {
					const rest = Buffer.from(buffer.subarray(from, bytes));
					pending.push(rest);
					pendingBytes += rest.length;
				}
				position += bytes;
			}
			this.#index.completeBytes = recordStart;
			// A valid final record without LF is visible, but must be replaced on append.
			if (pendingBytes) this.#consume(Buffer.concat(pending, pendingBytes), recordStart, pendingBytes);
			const prefix = Buffer.allocUnsafe(Math.min(4096, current.size));
			const prefixBytes = fs.readSync(fd, prefix, 0, prefix.length, 0);
			this.#bytesRead += prefixBytes;
			this.#index.prefixHash = createHash("sha256").update(prefix.subarray(0, prefixBytes)).digest("hex");
			this.#index.prefixBytes = prefixBytes;
		} finally {
			fs.closeSync(fd);
		}
		this.#index.stamp = current;
		this.#dirty = true;
		this.#revision++;
		this.#rebuildLookup();
	}
	#prefixUnchanged(previous: JournalIndex): boolean {
		if (previous.completeBytes !== previous.stamp.size) return false;
		const first = previous.entries[0];
		const last = previous.entries.at(-1);
		if (!first || !last) return false;
		try {
			const fd = fs.openSync(this.filePath, "r");
			try {
				const prefix = Buffer.allocUnsafe(previous.prefixBytes);
				const read = fs.readSync(fd, prefix, 0, prefix.length, 0);
				this.#bytesRead += read;
				if (read !== prefix.length || createHash("sha256").update(prefix).digest("hex") !== previous.prefixHash)
					return false;
				for (const ref of [first, last]) {
					const bytes = Buffer.allocUnsafe(ref.length);
					if (fs.readSync(fd, bytes, 0, bytes.length, ref.offset) !== bytes.length) return false;
					this.#bytesRead += bytes.length;
					const payload = bytes[bytes.length - 1] === 10 ? bytes.subarray(0, -1) : bytes;
					if (createHash("sha256").update(payload).digest("hex") !== ref.checksum) return false;
				}
			} finally {
				fs.closeSync(fd);
			}
			return true;
		} catch {
			return false;
		}
	}
	#consume(bytes: Uint8Array, offset: number, length: number): void {
		const line = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
		if (!line.trim()) return;
		const title = offset === 0 ? titleUpdateFromSlot(parseTitleSlotLine(line)) : undefined;
		if (title) {
			this.#index.titleSlot = title;
			return;
		}
		try {
			const entry: unknown = JSON.parse(line);
			this.#entriesParsed++;
			if (!record(entry) || typeof entry.id !== "string" || typeof entry.type !== "string") {
				this.#index.malformedRecords++;
				return;
			}
			if (!this.#index.header && this.#index.entries.length === 0 && entry.type === "session") {
				this.#index.header = entry as unknown as SessionHeader;
				const slot = this.#index.titleSlot;
				if (slot) {
					this.#index.header.title = slot.title;
					this.#index.header.titleSource = slot.source;
				}
			} else
				this.#index.entries.push(
					reference(entry, offset, length, createHash("sha256").update(bytes).digest("hex")),
				);
		} catch {
			this.#index.malformedRecords++;
		}
	}
	#rebuildLookup(): void {
		this.#byId.clear();
		for (const entry of this.entries) this.#byId.set(entry.id, entry);
	}
	readEntrySync(ref: IndexedSessionEntry, filePath = this.filePath): FileEntry {
		// Another writer can atomically replace the source (including inserting a
		// title slot) before a lazy rewrite consumer reaches this record. Resolve
		// its ID against the current source before using any old byte offset.
		if (filePath === this.filePath) this.refreshSync();
		const current = filePath === this.filePath ? this.#byId.get(ref.id) : ref;
		if (!current) throw new Error(`Session entry ${ref.id} is no longer present in its source`);
		const fd = fs.openSync(filePath, "r");
		try {
			const bytes = Buffer.allocUnsafe(current.length);
			let read = 0;
			while (read < bytes.length) {
				const count = fs.readSync(fd, bytes, read, bytes.length - read, current.offset + read);
				if (!count) throw new Error(`Session entry ${ref.id} was truncated`);
				read += count;
				this.#bytesRead += count;
				this.#entryBytesRead += count;
			}
			this.#entriesParsed++;
			this.#entryEntriesParsed++;
			const entry = JSON.parse(bytes.toString("utf8")) as FileEntry;
			if (entry.id !== ref.id) throw new Error(`Session entry ${ref.id} index is stale`);
			const payload = bytes[bytes.length - 1] === 10 ? bytes.subarray(0, -1) : bytes;
			if (createHash("sha256").update(payload).digest("hex") !== current.checksum)
				throw new Error(`Session entry ${ref.id} source version is stale`);
			return entry;
		} finally {
			fs.closeSync(fd);
		}
	}
	async readEntry(ref: IndexedSessionEntry): Promise<FileEntry> {
		this.refreshSync();
		const current = this.#byId.get(ref.id);
		if (!current) throw new Error(`Session entry ${ref.id} is no longer present in its source`);
		const file = await fs.promises.open(this.filePath, "r");
		try {
			const bytes = Buffer.allocUnsafe(current.length);
			let read = 0;
			while (read < bytes.length) {
				const { bytesRead } = await file.read(bytes, read, bytes.length - read, current.offset + read);
				if (!bytesRead) throw new Error(`Session entry ${ref.id} was truncated`);
				read += bytesRead;
				this.#bytesRead += bytesRead;
				this.#entryBytesRead += bytesRead;
			}
			this.#entriesParsed++;
			this.#entryEntriesParsed++;
			const entry = JSON.parse(bytes.toString("utf8")) as FileEntry;
			if (entry.id !== ref.id) throw new Error(`Session entry ${ref.id} index is stale`);
			const payload = bytes[bytes.length - 1] === 10 ? bytes.subarray(0, -1) : bytes;
			if (createHash("sha256").update(payload).digest("hex") !== current.checksum)
				throw new Error(`Session entry ${ref.id} source version is stale`);
			return entry;
		} finally {
			await file.close();
		}
	}
}

/** Conservative UTF-16/container estimate without serializing or copying journal bodies. */
export function estimateSessionValueBytes(value: unknown): number {
	if (typeof value === "string") return 32 + value.length * 2;
	if (typeof value !== "object" || value === null) return 8;
	let bytes = Array.isArray(value) ? 64 : 96;
	for (const key of Object.keys(value))
		bytes += 32 + key.length * 2 + estimateSessionValueBytes((value as Record<string, unknown>)[key]);
	return bytes;
}
const indexedTaskUsage = new WeakMap<object, { usage?: unknown }>();
export function getIndexedTaskUsage(entry: object): { usage?: unknown } | undefined {
	return indexedTaskUsage.get(entry);
}
interface ColdBody {
	entry: Record<string, unknown>;
	bytes: number;
}
interface ColdPath {
	parent?: ColdPath;
	key: PropertyKey | { digest: string };
	cacheKey?: PropertyKey;
	proxy?: WeakRef<object>;
	children?: Map<PropertyKey, WeakRef<ColdPath>>;
}
interface ColdHandle {
	ref: IndexedSessionEntry;
	sourceFilePath: string;
	pinned?: ColdBody;
	message?: object;
}
/** Sync-compatible bodies: only the bounded LRU and uncommitted edits own full payloads.
 * Borrowed containers are stable path views, not weak references to hydrated bodies:
 * WeakRef construction/deref would otherwise retain every body until the current job ends.
 */
export class SessionEntryBodyCache {
	readonly journal: IndexedSessionJournal;
	readonly maxBytes: number;
	#cache = new Map<ColdHandle, ColdBody>();
	#handles = new WeakMap<object, ColdHandle>();
	#pinned = new Set<ColdHandle>();
	#borrowed = new Map<ColdHandle, Set<WeakRef<object>>>();
	#paths = new WeakMap<object, { handle: ColdHandle; path: ColdPath }>();
	#facadeRegistry = new FinalizationRegistry<{
		handle: ColdHandle;
		ref: WeakRef<object>;
		parent?: ColdPath;
		key: PropertyKey;
		path: WeakRef<ColdPath>;
	}>(held => {
		const refs = this.#borrowed.get(held.handle);
		refs?.delete(held.ref);
		if (!refs?.size) this.#borrowed.delete(held.handle);
		if (held.parent?.children?.get(held.key) === held.path && held.path.deref()?.proxy === held.ref)
			held.parent?.children?.delete(held.key);
	});
	#residentBytes = 0;
	#hydrate: (entry: FileEntry) => void;
	constructor(journal: IndexedSessionJournal, hydrate: (entry: FileEntry) => void, maxBytes = 8 * 1024 * 1024) {
		this.journal = journal;
		this.maxBytes = maxBytes;
		this.#hydrate = hydrate;
	}
	onMutation?: () => void;
	getStats(): {
		residentBodyBytes: number;
		cachedBodyBytes: number;
		pinnedBodyBytes: number;
		borrowedBodyBytes: number;
		overBudgetBytes: number;
		cachedEntries: number;
		pinnedEntries: number;
		borrowedEntries: number;
		maxBytes: number;
	} {
		let pinnedBodyBytes = 0;
		for (const handle of this.#pinned)
			if (handle.pinned) pinnedBodyBytes += estimateSessionValueBytes(handle.pinned.entry);
		// A facade owns no hydrated body. Caller-created copies/primitive strings are
		// caller memory, not manager retention; uncommitted edits are counted above.
		const borrowedBodyBytes = 0;
		let borrowedEntries = 0;
		for (const [handle, refs] of this.#borrowed) {
			for (const ref of refs) if (!ref.deref()) refs.delete(ref);
			if (!refs.size) {
				this.#borrowed.delete(handle);
				continue;
			}
			if (!this.#cache.has(handle) && !handle.pinned) borrowedEntries++;
		}
		const residentBodyBytes = this.#residentBytes + pinnedBodyBytes + borrowedBodyBytes;
		return {
			residentBodyBytes,
			cachedBodyBytes: this.#residentBytes,
			pinnedBodyBytes,
			borrowedBodyBytes,
			overBudgetBytes: Math.max(0, residentBodyBytes - this.maxBytes),
			cachedEntries: this.#cache.size,
			pinnedEntries: this.#pinned.size,
			borrowedEntries,
			maxBytes: this.maxBytes,
		};
	}
	isCold(entry: object): boolean {
		const handle = this.#handles.get(entry);
		if (!handle || (handle.ref.messageKeys && (entry as Record<string, unknown>).message !== handle.message))
			return false;
		for (const key of Object.keys(entry))
			if (key !== "message" && !(key in handle.ref.metadata) && !Object.getOwnPropertyDescriptor(entry, key)?.get)
				return false;
		if (handle.message)
			for (const key of Object.keys(handle.message))
				if (!MESSAGE_METADATA.includes(key) && !Object.getOwnPropertyDescriptor(handle.message, key)?.get)
					return false;
		return true;
	}
	#read(handle: ColdHandle): FileEntry {
		// A full fork can drop a branch while callers still hold its entry/tree.
		// Its original durable journal remains the source for those path views.
		this.journal.refreshSync();
		const current = this.journal.get(handle.ref.id);
		if (current) return this.journal.readEntrySync(current);
		return this.journal.readEntrySync(handle.ref, handle.sourceFilePath);
	}
	#body(handle: ColdHandle): ColdBody {
		if (handle.pinned) return handle.pinned;
		let body = this.#cache.get(handle);
		if (body) {
			this.#cache.delete(handle);
			this.#cache.set(handle, body);
			return body;
		}
		const entry = this.#read(handle);
		this.#hydrate(entry);
		// Images may expand a short blob ref into a large base64 payload.
		body = { entry: entry as unknown as Record<string, unknown>, bytes: estimateSessionValueBytes(entry) };
		this.#cache.set(handle, body);
		this.#residentBytes += body.bytes;
		while (this.#residentBytes > this.maxBytes && this.#cache.size) {
			const oldest = this.#cache.entries().next().value!;
			this.#cache.delete(oldest[0]);
			this.#residentBytes -= oldest[1].bytes;
		}
		return body;
	}
	#pin(handle: ColdHandle, body: ColdBody): void {
		const cached = this.#cache.get(handle);
		if (cached) {
			this.#cache.delete(handle);
			this.#residentBytes -= cached.bytes;
		}
		handle.pinned = body;
		this.#pinned.add(handle);
		this.onMutation?.();
	}
	#source(handle: ColdHandle, path: ColdPath, body = this.#body(handle)): object {
		const parent = path.parent ? this.#source(handle, path.parent, body) : body.entry;
		let key = path.key;
		if (typeof key === "object") {
			const digest = key.digest;
			const resolved = Reflect.ownKeys(parent).find(
				candidate =>
					typeof candidate === "string" && createHash("sha256").update(candidate).digest("hex") === digest,
			);
			if (resolved === undefined) throw new TypeError("Session container property was deleted");
			key = resolved;
		}
		const value: unknown = Reflect.get(parent, key);
		if (typeof value !== "object" || value === null)
			throw new TypeError("Session container was replaced by a non-container");
		return value;
	}
	#unwrap(value: unknown): unknown {
		if (typeof value !== "object" || value === null) return value;
		const tracked = this.#paths.get(value);
		if (tracked) return this.#source(tracked.handle, tracked.path);
		// Filter/spread build ordinary containers whose children can still be path
		// facades. Storing one into its own backing path makes that view recursive.
		// Resolve nested facades before assignment; copy only changed containers.
		const source = value as Record<string, unknown>;
		let copy: object | undefined;
		for (const key in source) {
			if (!Object.hasOwn(source, key)) continue;
			const child = source[key];
			const unwrapped = this.#unwrap(child);
			if (unwrapped === child) continue;
			copy ??= Array.isArray(value) ? value.slice() : { ...source };
			Reflect.set(copy, key, unwrapped);
		}
		return copy ?? value;
	}
	#track(value: unknown, handle: ColdHandle, path: ColdPath): unknown {
		if (typeof value !== "object" || value === null) return value;
		const existing = path.proxy?.deref();
		if (existing) return existing;
		// Construct in a separate scope so no trap can capture value or its body.
		return this.#facade(handle, path, Array.isArray(value));
	}
	#child(value: unknown, handle: ColdHandle, parent: ColdPath, key: PropertyKey): unknown {
		if (typeof value !== "object" || value === null) return value;
		const children = (parent.children ??= new Map());
		// Payload object keys themselves can be huge. Keep a fixed-size digest,
		// not another copy/reference to an unbounded piece of the journal body.
		const digest =
			typeof key === "string" && key.length > 512 ? createHash("sha256").update(key).digest("hex") : undefined;
		const cacheKey = typeof key === "string" ? (digest ? `hash:${digest}` : `key:${key}`) : key;
		let path = children.get(cacheKey)?.deref();
		if (!path) {
			path = { parent, key: digest ? { digest } : key, cacheKey };
			children.set(cacheKey, new WeakRef(path));
		}
		return this.#track(value, handle, path);
	}
	#facade(handle: ColdHandle, path: ColdPath, array: boolean): object {
		const target: object = array ? [] : {};
		const proxy = new Proxy(target, {
			get: (_target, key, receiver) =>
				this.#child(Reflect.get(this.#source(handle, path), key, receiver), handle, path, key),
			has: (_target, key) => Reflect.has(this.#source(handle, path), key),
			ownKeys: () => Reflect.ownKeys(this.#source(handle, path)),
			getPrototypeOf: () => Reflect.getPrototypeOf(this.#source(handle, path)),
			getOwnPropertyDescriptor: (_target, key) => {
				const descriptor = Reflect.getOwnPropertyDescriptor(this.#source(handle, path), key);
				if (!descriptor) return undefined;
				if ("value" in descriptor) descriptor.value = this.#child(descriptor.value, handle, path, key);
				// JSON properties are configurable. Array length is the sole intrinsic
				// nonconfigurable property of the empty target and remains writable.
				if (!(array && key === "length")) descriptor.configurable = true;
				return descriptor;
			},
			set: (_target, key, next) => {
				const body = this.#body(handle);
				const source = this.#source(handle, path, body);
				this.#pin(handle, body);
				return Reflect.set(source, key, this.#unwrap(next));
			},
			deleteProperty: (_target, key) => {
				const body = this.#body(handle);
				this.#pin(handle, body);
				return Reflect.deleteProperty(this.#source(handle, path, body), key);
			},
			defineProperty: (_target, key, descriptor) => {
				const body = this.#body(handle);
				this.#pin(handle, body);
				const next = { ...descriptor };
				if ("value" in next) next.value = this.#unwrap(next.value);
				return Reflect.defineProperty(this.#source(handle, path, body), key, next);
			},
			setPrototypeOf: (_target, prototype) => {
				const body = this.#body(handle);
				this.#pin(handle, body);
				return Reflect.setPrototypeOf(this.#source(handle, path, body), prototype);
			},
			// Locking an empty facade would require copying the whole payload into
			// its target. Do not silently create a second, unbounded body owner.
			preventExtensions: () => false,
		});
		const ref = new WeakRef(proxy);
		path.proxy = ref;
		let refs = this.#borrowed.get(handle);
		if (!refs) {
			refs = new Set();
			this.#borrowed.set(handle, refs);
		}
		refs.add(ref);
		this.#paths.set(proxy, { handle, path });
		const key = path.cacheKey ?? (typeof path.key === "object" ? path.key.digest : path.key);
		this.#facadeRegistry.register(proxy, {
			handle,
			ref,
			parent: path.parent,
			key,
			path: path.parent?.children?.get(key) ?? new WeakRef(path),
		});
		return proxy;
	}
	makeCold(entry: FileEntry, ref: IndexedSessionEntry): FileEntry {
		if (ref.taskUsage) indexedTaskUsage.set(entry, ref.taskUsage);
		const existing = this.#handles.get(entry);
		if (existing && this.isCold(entry)) {
			existing.ref = ref;
			existing.sourceFilePath = this.journal.filePath;
			return entry;
		}
		const handle: ColdHandle = { ref, sourceFilePath: this.journal.filePath };
		this.#handles.set(entry, handle);
		const target = entry as unknown as Record<string, unknown>;
		const messagePath: ColdPath = { key: "message" };
		const lazy = (holder: Record<string, unknown>, key: string, message = false): void => {
			const valuePath: ColdPath = { key, parent: message ? messagePath : undefined };
			Object.defineProperty(holder, key, {
				enumerable: true,
				configurable: true,
				get: () => {
					const body = this.#body(handle);
					const source = message ? (body.entry.message as Record<string, unknown>) : body.entry;
					return this.#track(source[key], handle, valuePath);
				},
				set: value => {
					const body = this.#body(handle);
					this.#pin(handle, body);
					const source = message ? (body.entry.message as Record<string, unknown>) : body.entry;
					source[key] = this.#unwrap(value);
				},
			});
		};
		for (const key of ref.keys) {
			if (key === "message" && ref.messageKeys) {
				const message = { ...(ref.metadata.message as Record<string, unknown>) };
				for (const child of ref.messageKeys) if (!(child in message)) lazy(message, child, true);
				target.message = message;
				handle.message = message;
			} else if (!(key in ref.metadata)) lazy(target, key);
		}
		return entry;
	}
	/** Serialize persisted cold records without hydrating their image/blob payloads. */
	entryForPersistence(entry: FileEntry): FileEntry | undefined {
		const handle = this.#handles.get(entry);
		if (!handle) return undefined;
		const raw = handle.pinned?.entry ?? (this.#read(handle) as unknown as Record<string, unknown>);
		const target = entry as unknown as Record<string, unknown>;
		for (const key of Object.keys(raw)) if (!(key in target)) delete raw[key];
		for (const key of Object.keys(target))
			if (key !== "message" && !Object.getOwnPropertyDescriptor(target, key)?.get) raw[key] = target[key];
		if (handle.ref.messageKeys) {
			if (target.message !== handle.message) raw.message = target.message;
			else {
				const message = raw.message as Record<string, unknown>;
				const retained = target.message as Record<string, unknown>;
				for (const key of Object.keys(message)) if (!(key in retained)) delete message[key];
				for (const key of Object.keys(retained))
					if (!Object.getOwnPropertyDescriptor(retained, key)?.get) message[key] = retained[key];
			}
		}
		return raw as unknown as FileEntry;
	}
	commit(): void {
		for (const handle of this.#pinned) handle.pinned = undefined;
		this.#pinned.clear();
		this.#cache.clear();
		this.#residentBytes = 0;
	}
}

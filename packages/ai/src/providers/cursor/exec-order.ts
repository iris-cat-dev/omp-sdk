/**
 * Orders exec frames like a local tool batch: mutations wait for earlier calls
 * and hold later calls. A native edit spans a read and a write under one call id,
 * so it keeps its place until the write lands or the server completes it.
 */
interface OrderedCall {
	readonly exclusive: boolean;
	readonly ready: Promise<boolean>;
	readonly done: Promise<void>;
	readonly release: () => void;
}

export class CursorExecOrder {
	readonly #calls = new Map<string, OrderedCall>();
	readonly #closed = Promise.withResolvers<false>();
	#isClosed = false;

	get closed(): boolean {
		return this.#isClosed;
	}

	get idle(): boolean {
		return this.#calls.size === 0;
	}

	/** Called synchronously in frame arrival order; false means the run ended while waiting. */
	enter(callId: string, exclusive: boolean): Promise<boolean> {
		if (this.#isClosed) return Promise.resolve(false);
		const existing = this.#calls.get(callId);
		if (existing) return existing.ready;
		const blockers: Promise<void>[] = [];
		for (const call of this.#calls.values()) {
			if (exclusive || call.exclusive) blockers.push(call.done);
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		const ready =
			blockers.length === 0
				? Promise.resolve(true)
				: Promise.race([Promise.all(blockers).then(() => !this.#isClosed), this.#closed.promise]);
		this.#calls.set(callId, { exclusive, ready, done: promise, release: resolve });
		return ready;
	}

	/** Releases a completed call, including a native edit's server-only completion. */
	leave(callId: string): void {
		const call = this.#calls.get(callId);
		if (!call) return;
		this.#calls.delete(callId);
		call.release();
	}

	/** Prevents queued and subsequently arriving frames from running after cancellation or transport end. */
	close(): void {
		this.#isClosed = true;
		this.#closed.resolve(false);
	}
}

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@oh-my-pi/pi-natives";

export const SANDBOX_FS_VERSION = 1;
export interface AgentSandbox { root: string }
export interface SandboxFileStat { isDirectory: boolean; size: number; modifiedAt: number }
export interface SandboxFileEntry extends SandboxFileStat { name: string }
export interface SandboxFs {
	read(path: string, maxBytes?: number): Buffer;
	write(path: string, bytes: Buffer, options?: { exclusive?: boolean }): void;
	list(path: string): SandboxFileEntry[];
	stat(path: string): SandboxFileStat;
	mkdir(path: string): void;
	remove(path: string): void;
	close(): void;
}
interface NativeSandboxFs extends Omit<SandboxFs, "write"> { write(path: string, bytes: Buffer, exclusive?: boolean): void }
interface NativeSandboxModule { SandboxFs?: new(root: string, maxBytes?: number) => NativeSandboxFs }
// The NAPI declaration is generated only after the addon build; the runtime export is checked below.
const sandboxModule = natives as unknown as NativeSandboxModule;

/** Trusted host-only entry. No SDK/session/bootstrap initialization; no realpath-only fallback. */
export async function openSandboxFs(sandbox: AgentSandbox & { maxBytes?: number }): Promise<SandboxFs> {
	if (!path.isAbsolute(sandbox.root) || !sandbox.root.trim() || sandbox.root.includes("\0")) throw new Error("Sandbox root must be an absolute directory");
	const maxBytes = sandbox.maxBytes ?? 1024 * 1024;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 200 * 1024 * 1024) throw new Error("Invalid sandbox file byte limit");
	const root = await fs.realpath(sandbox.root).catch(error => { throw new Error("Sandbox root cannot be opened", { cause: error }); });
	const home = await fs.realpath(os.homedir()).catch(error => { throw new Error("Sandbox home boundary cannot be resolved", { cause: error }); });
	if (root === path.parse(root).root || root === home) throw new Error("Sandbox root cannot be the filesystem root or user home");
	const requested = await fs.lstat(sandbox.root).catch(error => { throw new Error("Sandbox root cannot be opened", { cause: error }); });
	if (!requested.isDirectory() || requested.isSymbolicLink()) throw new Error("Sandbox root must be a real directory");
	const Constructor = sandboxModule.SandboxFs;
	if (typeof Constructor !== "function") throw new Error("Secure sandbox filesystem primitive is unavailable; rebuild the native addon");
	const native = new Constructor(root, maxBytes);
	return Object.freeze({
		read: (relative: string, limit?: number) => {
			if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > maxBytes)) throw new Error("Invalid sandbox file byte limit");
			return native.read(relative, limit);
		},
		write: (relative: string, bytes: Buffer, options?: { exclusive?: boolean }) => native.write(relative, bytes, options?.exclusive),
		list: (relative: string) => native.list(relative),
		stat: (relative: string) => native.stat(relative),
		mkdir: (relative: string) => native.mkdir(relative),
		remove: (relative: string) => native.remove(relative),
		close: () => native.close(),
	});
}

import * as fs from "node:fs";
import { createRequire } from "node:module";
import type * as NodeModule from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const hostRequire = createRequire(import.meta.url);
let installed = false;
let activeLoads = 0;
const owned = new Set<string>();

function sourcePath(url: string): string | undefined {
	return url.startsWith("file:") ? fileURLToPath(url) : undefined;
}

function resolveFile(specifier: string, parentURL: string): string | undefined {
	const target = fileURLToPath(new URL(specifier, parentURL));
	for (const candidate of [
		target,
		...[".js", ".mjs", ".cjs"].map(ext => target + ext),
		path.join(target, "index.js"),
	]) {
		try {
			if (fs.statSync(candidate).isFile()) return pathToFileURL(candidate).href;
		} catch {
			/* Continue normal extension resolution. */
		}
	}
	return undefined;
}

function rejectSourceModule(filename: string): void {
	if (/\.(?:ts|tsx|mts|cts|jsx)$/.test(filename)) {
		throw new Error(
			`Node plugins cannot execute TypeScript or JSX modules: ${filename}. Precompile plugins and their dependencies to .js, .mjs, or .cjs before loading them.`,
		);
	}
}

/** Install synchronous Node hooks; real module evaluation stays in Node's loader. */
export function installNodeExtensionHooks(resolveHost: (specifier: string) => string | null): void {
	if (installed) return;
	const { registerHooks }: typeof NodeModule = hostRequire("node:module");
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const host = resolveHost(specifier);
			if (host) {
				// The manifest already resolved this host module. CJS resolution
				// does not accept file URLs as specifiers; both loaders accept them
				// as hook results and share the same untagged host identity.
				if (host.startsWith("file:")) return { url: host, shortCircuit: true };
				return nextResolve(host.startsWith("#") ? hostRequire.resolve(host) : host, {
					...context,
					parentURL: import.meta.url,
				});
			}
			let result;
			try {
				result = nextResolve(specifier, context);
			} catch (error) {
				if (!context.parentURL || !specifier.startsWith(".")) throw error;
				const candidate = resolveFile(specifier, context.parentURL);
				if (!candidate) throw error;
				result = { url: candidate, shortCircuit: true };
			}
			const parentPath = context.parentURL && sourcePath(context.parentURL);
			const targetPath = sourcePath(result.url);
			if (targetPath && context.importAttributes?.type !== "text") rejectSourceModule(targetPath);
			if (parentPath && owned.has(parentPath) && targetPath) {
				owned.add(targetPath);
				const tag = new URL(context.parentURL!).searchParams.get("mtime");
				if (tag) {
					const target = new URL(result.url);
					target.searchParams.set("mtime", tag);
					result = { ...result, url: target.href };
				}
			}
			return result;
		},
		load(url, context, nextLoad) {
			const filename = sourcePath(url);
			if (!filename) return nextLoad(url, context);
			if (context.importAttributes?.type === "text") {
				return {
					format: "module",
					source: `export default ${JSON.stringify(fs.readFileSync(filename, "utf8"))};`,
					shortCircuit: true,
				};
			}
			rejectSourceModule(filename);
			return nextLoad(url, context);
		},
	});
	installed = true;
}

export async function loadNodeExtensionModule(
	filename: string,
	tag: string | undefined,
	resolveHost: (specifier: string) => string | null,
): Promise<unknown> {
	rejectSourceModule(filename);
	installNodeExtensionHooks(resolveHost);
	const realPath = fs.realpathSync(filename);
	rejectSourceModule(realPath);
	owned.add(realPath);
	// Concurrent imports share one reload wave: deleting a CJS cache entry
	// while Node is evaluating its ESM wrapper violates Node's cache invariant.
	if (tag && activeLoads === 0) {
		for (const key of Object.keys(hostRequire.cache)) {
			if (owned.has(key)) delete hostRequire.cache[key];
		}
	}
	const url = pathToFileURL(realPath);
	if (tag) url.searchParams.set("mtime", tag);
	activeLoads++;
	// Plugin URLs are selected at runtime, including the reload tag.
	try {
		return await import(url.href);
	} finally {
		activeLoads--;
	}
}

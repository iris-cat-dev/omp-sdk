import {
	CANONICAL_PI_SCOPE,
	PI_PACKAGE_NAMES,
	remapLegacyPiSpecifier,
	TYPEBOX_SPECIFIER_FILTER,
} from "./legacy-pi-specifiers";
import { installNodeExtensionHooks, loadNodeExtensionModule } from "./node-loader";
import { resolveNodeSdkModule } from "./node-module-map";

let legacyPiLoadTag = 0;
let hostModulesReady: Promise<unknown[]> | undefined;

function ensureNodeHostModulesReady(): Promise<unknown[]> {
	if (hostModulesReady) return hostModulesReady;
	const loads: Promise<unknown>[] = [];
	// Only mapped package roots and the shared TypeBox facade must be ready
	// before synchronous CJS require. All plugin graphs remain parallel.
	for (const name of PI_PACKAGE_NAMES) {
		const host = resolveNodeSdkModule(`${CANONICAL_PI_SCOPE}/${name}`);
		if (host) {
			// URLs come from the packaged manifest, not static build-time edges.
			loads.push(import(host));
		}
	}
	const typebox = resolveNodeSdkModule("typebox");
	if (typebox) loads.push(import(typebox));
	hostModulesReady = Promise.all(loads);
	return hostModulesReady;
}

function resolveNodeHostSpecifier(specifier: string): string | null {
	if (TYPEBOX_SPECIFIER_FILTER.test(specifier)) {
		return resolveNodeSdkModule("typebox") ?? new URL("../legacy-typebox.ts", import.meta.url).href;
	}
	const canonical = remapLegacyPiSpecifier(specifier) ?? (specifier.startsWith("@oh-my-pi/pi-") ? specifier : null);
	if (!canonical) return null;
	const emitted = resolveNodeSdkModule(canonical);
	if (emitted) return emitted;
	if (canonical === "@oh-my-pi/pi-coding-agent") {
		return new URL("../legacy-pi-coding-agent-shim.ts", import.meta.url).href;
	}
	if (canonical === "@oh-my-pi/pi-ai") return new URL("../legacy-pi-ai-shim.ts", import.meta.url).href;
	if (canonical === "@oh-my-pi/pi-tui") return new URL("../legacy-pi-tui-shim.ts", import.meta.url).href;
	return canonical;
}

/** Install Node's real ESM/CommonJS loader hooks without retaining Bun's graph evaluator. */
export function installLegacyPiSpecifierShim(): void {
	installNodeExtensionHooks(resolveNodeHostSpecifier);
}

/** Load in place; tagged imports reload the graph, while reload:false keeps Node's module cache. */
export async function loadLegacyPiModule(resolvedPath: string, options: { reload?: boolean } = {}): Promise<unknown> {
	installLegacyPiSpecifierShim();
	await ensureNodeHostModulesReady();
	let tag: string | undefined;
	if (options.reload !== false) {
		legacyPiLoadTag = Math.max(legacyPiLoadTag + 1, Date.now());
		tag = String(legacyPiLoadTag);
	}
	return loadNodeExtensionModule(resolvedPath, tag, resolveNodeHostSpecifier);
}

#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { isBuiltin } from "node:module";
import * as path from "node:path";
import type { BunPlugin } from "bun";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { bundleNodeRuntime } from "../../utils/scripts/bundle-node";
import { createNodeSourceMetadataPlugin } from "../../utils/scripts/node-source-metadata";
import { buildDocsIndexPayload } from "./generate-docs-index";
import { createJsonParsePlugin } from "./json-parse-plugin";
import { collectBundledPiEntries, type BundledPiEntry } from "./legacy-pi-virtual-module";

const packageDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const utilsSourceDir = path.join(repoRoot, "packages", "utils", "src");
type NodeSdkBuildTarget = "generic" | "desktop";
const sdkArtifactDirectories: Record<NodeSdkBuildTarget, string> = {
	generic: "dist/node",
	desktop: "dist/node-desktop",
};
const codingAgentPrefix = "@oh-my-pi/pi-coding-agent";
const desktopModuleAliases = new Set([
	`${codingAgentPrefix}/sdk`,
	`${codingAgentPrefix}/headless`,
	`${codingAgentPrefix}/async`,
	`${codingAgentPrefix}/extensibility/host-api`,
	`${codingAgentPrefix}/session/indexed-session-journal`,
	"@oh-my-pi/pi-ai/providers/transform-messages",
	"@oh-my-pi/pi-ai/auth-gateway",
	"@oh-my-pi/pi-ai/utils/retry-after",
	"@oh-my-pi/pi-ai/utils/tool-call-arguments",
	"@oh-my-pi/pi-ai/utils/empty-completion-retry",
	"@oh-my-pi/pi-catalog/build",
	"@oh-my-pi/pi-tui/chrome/qrcode",
]);

// Optional installed capabilities, not a denylist inferred from package names.
// Full SDK staging retains these edges and their existing required/optional
// semantics; the core profile excludes their complete installed subtrees.
const optionalCapabilities = {
	"local-models": ["@huggingface/transformers", "onnxruntime-node"],
	"local-embeddings": ["fastembed"],
	"offline-speech": ["sherpa-onnx-node"],
} satisfies Record<string, string[]>;

const runtimeModules: Record<string, string> = {
	runtime: "@oh-my-pi/pi-utils/runtime",
	"runtime-process": "@oh-my-pi/pi-utils/runtime-process",
	"runtime-image": "@oh-my-pi/pi-utils/runtime-image",
	"sqlite-driver": "@oh-my-pi/pi-utils/sqlite-driver",
};
const runtimeSpecifiers: Readonly<Record<string, true>> = Object.fromEntries(
	Object.values(runtimeModules).map(specifier => [specifier, true as const]),
);
const runtimeSourceTargets: Readonly<Record<string, string>> = Object.fromEntries(
	Object.entries(runtimeModules).map(([name, specifier]) => [path.join(utilsSourceDir, name), specifier]),
);

function createNodeRuntimeExternalPlugin(): BunPlugin {
	return {
		name: "omp-node-runtime-externals",
		target: "node",
		setup(build) {
			build.onResolve(
				{
					filter:
						/^@oh-my-pi\/pi-utils\/(?:runtime(?:-process|-image)?|sqlite-driver)$|^(?:\.\.?[/\\])+(?:runtime(?:-process|-image)?|sqlite-driver)(?:\.[jt]s)?$|[/\\]packages[/\\]utils[/\\]src[/\\](?:runtime(?:-process|-image)?|sqlite-driver)(?:\.[jt]s)?$/,
				},
				args => {
					if (runtimeSpecifiers[args.path]) return { path: args.path, external: true };
					const resolved = path.resolve(args.resolveDir, args.path).replace(/\.[jt]s$/, "");
					const target = runtimeSourceTargets[resolved];
					if (target) return { path: target, external: true };
					return undefined;
				},
			);
			build.onResolve({ filter: /^@oh-my-pi\/pi-coding-agent(?:\/(?:sdk|headless))?$/ }, () => ({
				path: path.join(packageDir, "src", "headless.ts"),
			}));
			build.onResolve({ filter: /^#coding-agent-(?:headless|host-api)$/ }, args => ({
				path: path.join(
					packageDir,
					"src",
					args.path === "#coding-agent-headless" ? "headless.ts" : "extensibility/host-api.node.ts",
				),
			}));
			// The UMD build passes require through a factory, preventing static bundling.
			build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
				path: Bun.resolveSync("jsonc-parser/lib/esm/main.js", packageDir),
			}));
			build.onResolve({ filter: /^@oh-my-pi\// }, args => {
				if (args.path === "@oh-my-pi/pi-natives" || args.path.startsWith("@oh-my-pi/pi-natives/")) {
					return { path: args.path, external: true };
				}
				return { path: Bun.resolveSync(args.path, packageDir) };
			});
		},
	};
}

function exposeToNode(entry: BundledPiEntry): boolean {
	// External facades must resolve to installed packages, not aliases that re-export themselves.
	if (
		runtimeSpecifiers[entry.key] ||
		entry.key === "@oh-my-pi/pi-natives" ||
		entry.key.startsWith("@oh-my-pi/pi-natives/")
	)
		return false;
	if (/\.(?:json|txt|md|css|html|svg|png)$/.test(entry.key)) return false;
	if (!entry.key.startsWith(codingAgentPrefix + "/")) return true;
	const subpath = entry.key.slice(codingAgentPrefix.length + 1);
	// The command entry owns bootstrap, not an extension host facade.
	if (subpath === "sdk/plugins") return false;
	return !/^(?:cli|main|modes)(?:\/|$)/.test(subpath) && !subpath.startsWith("node-");
}

function exposeToDesktop(entry: BundledPiEntry): boolean {
	// Retain package roots and the Desktop extension surface, not every source
	// file mirrored by wildcard exports. Their transitive graphs remain intact.
	return /^(?:@[^/]+\/)?[^/]+$/.test(entry.key) || desktopModuleAliases.has(entry.key);
}

function moduleEntryPath(key: string): string {
	if (!key.startsWith("@")) return `modules/${key}/_root`;
	const parts = key.slice(1).split("/");
	return `modules/${parts.slice(0, 2).join("/")}/${parts.length > 2 ? parts.slice(2).join("/") : "_root"}`;
}

async function sourcePackageDirs(): Promise<string[]> {
	const packagesDir = path.join(repoRoot, "packages");
	const entries = await fs.readdir(packagesDir, { withFileTypes: true });
	const directories: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const directory = path.join(packagesDir, entry.name);
		try {
			await fs.access(path.join(directory, "package.json"));
			directories.push(directory);
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
		}
	}
	return directories;
}

interface RuntimePackage {
	files: string[];
	dependencies: string[];
	optionalDependencies?: string[];
}

interface SourceDependencyManifest {
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

/**
 * Describe installed runtime scopes, not the source workspace dependency graph.
 * Literal imports come from the emitted bundles, including lazy worker/provider
 * chunks. createRequire and runtime-install edges are declared alongside them.
 */
async function writeRuntimeDependencies(
	outDir: string,
	result: Bun.BuildOutput,
	buildTarget: NodeSdkBuildTarget,
	virtualRoot: string,
): Promise<void> {
	if (!result.metafile) throw new Error("Node SDK build did not emit dependency metadata");
	const inputs = new Set(Object.keys(result.metafile.inputs).map(file => path.resolve(file)));
	const scanner = new Bun.Transpiler({ loader: "js", target: "node" });
	const packages: Record<string, RuntimePackage> = {};
	const requiredExternals = new Set<string>();
	const optionalExternals = new Set<string>();
	const owners = new Map<string, SourceDependencyManifest | undefined>();
	const sourcePackages = new Map<string, SourceDependencyManifest>();
	async function sourceOwner(file: string): Promise<SourceDependencyManifest | undefined> {
		let directory = path.dirname(path.resolve(file));
		const visited: string[] = [];
		let manifest: SourceDependencyManifest | undefined;
		for (;;) {
			if (owners.has(directory)) {
				manifest = owners.get(directory);
				break;
			}
			visited.push(directory);
			try {
				const candidate = (await Bun.file(path.join(directory, "package.json")).json()) as SourceDependencyManifest;
				if (candidate.name) {
					manifest = candidate;
					sourcePackages.set(directory, manifest);
					break;
				}
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			const parent = path.dirname(directory);
			if (parent === directory) break;
			directory = parent;
		}
		for (const directory of visited) owners.set(directory, manifest);
		return manifest;
	}
	const toPackage = (specifier: string): string | undefined => {
		if (
			isBuiltin(specifier) ||
			specifier === "bun" ||
			specifier.startsWith("bun:") ||
			specifier.startsWith(".") ||
			path.isAbsolute(specifier)
		)
			return undefined;
		// This Bun-only virtual module is served by modules.json under Node.
		if (specifier === "omp-legacy-pi-modules") return undefined;
		return specifier
			.split("/")
			.slice(0, specifier.startsWith("@") ? 2 : 1)
			.join("/");
	};
	async function walk(directory: string, relative = ""): Promise<string[]> {
		const files: string[] = [];
		for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
			if (entry.name === ".DS_Store" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const child = path.posix.join(relative, entry.name);
			if (entry.isDirectory()) files.push(...(await walk(directory, child)));
			else if (entry.isFile()) files.push(child);
		}
		return files;
	}
	async function bundleScope(
		nodeDir: string,
		dynamicDependencies: string[],
		artifactDirectory = "dist/node",
	): Promise<RuntimePackage> {
		const nodeFiles = (await walk(nodeDir)).filter(file => !file.endsWith(".map"));
		for (const dependency of dynamicDependencies) requiredExternals.add(dependency);
		const dependencies = new Set(dynamicDependencies);
		for (const file of nodeFiles) {
			if (!file.endsWith(".mjs")) continue;
			const source = await fs.readFile(path.join(nodeDir, file), "utf8");
			const headerEnd = source.startsWith("#!") ? source.indexOf("\n") : -1;
			const input = source.startsWith("#!") ? source.slice(headerEnd < 0 ? source.length : headerEnd + 1) : source;
			for (const imported of scanner.scanImports(input)) {
				const name = toPackage(imported.path);
				if (name) dependencies.add(name);
			}
		}
		return {
			files: ["package.json", ...nodeFiles.map(file => `${artifactDirectory}/${file}`)],
			dependencies: [...dependencies].sort(),
		};
	}
	// Bundled JavaScript no longer ships its npm directory; retain package and
	// vendored dependency licenses alongside the generated runtime artifacts.
	for (const file of inputs) await sourceOwner(file);
	for (const [directory, manifest] of sourcePackages) {
		if (!directory.includes(`${path.sep}node_modules${path.sep}`) || !manifest.name) continue;
		for (const file of await walk(directory)) {
			if (!/(?:^|\/)(?:LICEN[CS]E|COPYING|NOTICE|THIRD-PARTY-NOTICES)(?:[.-]|$)/i.test(file)) continue;
			await Bun.write(
				path.join(outDir, "licenses", `${manifest.name}@${manifest.version ?? "unversioned"}`, file),
				Bun.file(path.join(directory, file)),
			);
		}
	}
	// These loaders use createRequire or a runtime package-name variable, which
	// intentionally cannot be followed by a static bundler import graph.
	const artifactDirectory = sdkArtifactDirectories[buildTarget];
	packages[codingAgentPrefix] = await bundleScope(
		outDir,
		[
			"koffi", // utils/ptree.ts resolves the detached Node process guardian
			"@huggingface/transformers", // src/subprocess/worker-runtime.ts
			"fastembed", // pi-mnemopi's embedding runtime loader
			"sherpa-onnx-node", // src/stt/sherpa-runtime.ts
		],
		artifactDirectory,
	);
	packages["@oh-my-pi/pi-utils"] = await bundleScope(
		path.join(repoRoot, "packages", "utils", "dist", "node"),
		["sharp", "ws"], // runtime-image.ts and runtime-process.ts createRequire
	);
	for (const [file, input] of Object.entries(result.metafile.inputs)) {
		for (const imported of input.imports) {
			if (!imported.external) continue;
			const name = toPackage(imported.path);
			if (!name) continue;
			packages[codingAgentPrefix].dependencies.push(name);
			const owner = await sourceOwner(file);
			const optional =
				owner?.optionalDependencies?.[name] !== undefined ||
				(owner?.dependencies?.[name] === undefined && owner?.peerDependenciesMeta?.[name]?.optional === true);
			(optional ? optionalExternals : requiredExternals).add(name);
		}
	}
	for (const directory of await sourcePackageDirs()) {
		const sourcePrefix = path.join(directory, "src") + path.sep;
		if (directory !== packageDir && ![...inputs].some(file => file.startsWith(sourcePrefix))) continue;
		const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8")) as { name: string };
		const scope = (packages[manifest.name] ??= { files: ["package.json"], dependencies: [] });
		for (const file of await walk(directory, "src")) {
			// Bundled code/assets need no second source copy. Preserve unbundled
			// resource files (e.g. browser preludes) at source-metadata locations.
			if (/\.(?:[cm]?tsx?|map)$/.test(file) || inputs.has(path.join(directory, file))) continue;
			if (file.split("/").some(part => /^(?:test|tests|__tests__|docs|examples)$/.test(part))) continue;
			scope.files.push(file);
		}
		for (const file of await fs.readdir(directory)) {
			if (/^(?:LICEN[CS]E|COPYING|NOTICE|THIRD-PARTY-NOTICES)(?:[.-]|$)/i.test(file))
				if ((await fs.stat(path.join(directory, file))).isFile()) scope.files.push(file);
		}
		// Source metadata uses import.meta.resolve("<owner>/package.json").
		if (manifest.name !== codingAgentPrefix) packages[codingAgentPrefix].dependencies.push(manifest.name);
		scope.files.sort();
	}
	packages[codingAgentPrefix].files.push(`${artifactDirectory}/runtime-dependencies.json`);
	// getChangelogPath() is an exported package-resource API.
	if ((await fs.stat(path.join(packageDir, "CHANGELOG.md")).catch(() => null))?.isFile())
		packages[codingAgentPrefix].files.push("CHANGELOG.md");
	for (const [name, scope] of Object.entries(packages)) {
		const dependencies = [...new Set(scope.dependencies)].filter(dependency => dependency !== name).sort();
		const optional = dependencies.filter(
			dependency => optionalExternals.has(dependency) && !requiredExternals.has(dependency),
		);
		scope.optionalDependencies = optional;
		scope.dependencies = dependencies.filter(dependency => !optional.includes(dependency));
	}
	await Bun.write(
		path.join(outDir, "runtime-dependencies.json"),
		JSON.stringify({ version: 1, buildTarget, packages, optionalCapabilities }, null, 2),
	);
	// Build-only dependency watches stay outside the shipped SDK directory.
	const buildInputs = [
		...new Set([...inputs, ...[...sourcePackages.keys()].map(directory => path.join(directory, "package.json"))]),
	]
		.filter(file => !file.startsWith(virtualRoot + path.sep))
		.sort();
	const existingInputs = await Promise.all(
		buildInputs.map(async file =>
			(
				await fs.stat(file).catch(error => {
					if (isEnoent(error)) return undefined;
					throw error;
				})
			)?.isFile()
				? file
				: undefined,
		),
	);
	await Bun.write(
		path.join(repoRoot, "target", "node-sdk-build-inputs", `${buildTarget}.json`),
		JSON.stringify({ version: 1, buildTarget, files: existingInputs.filter(file => file !== undefined) }),
	);
}

/** Build a Node SDK plus one shared worker host; Bun is needed only by the build toolchain. */
export async function bundleNodeSdk(outDir?: string, buildTarget: NodeSdkBuildTarget = "generic"): Promise<void> {
	outDir ??= path.join(packageDir, sdkArtifactDirectories[buildTarget]);
	await bundleNodeRuntime();
	await fs.rm(outDir, { recursive: true, force: true });
	const virtualRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-node-sdk-build-"));
	try {
		const files: Record<string, string> = {};
		const sdkEntry = path.join(virtualRoot, "sdk.ts");
		const hostEntry = path.join(virtualRoot, "host.ts");
		const rpcEntry = path.join(virtualRoot, "rpc.ts");
		const pluginsEntry = path.join(virtualRoot, "plugins.ts");
		const sandboxEntry = path.join(virtualRoot, "sandbox.ts");
		files[sdkEntry] = `export * from ${JSON.stringify(path.join(packageDir, "src", "node-sdk.ts"))};`;
		files[hostEntry] = `import ${JSON.stringify(path.join(packageDir, "src", "node-cli.ts"))};`;
		files[rpcEntry] = `export * from ${JSON.stringify(path.join(packageDir, "src", "node-rpc.ts"))};`;
		files[pluginsEntry] = `export * from ${JSON.stringify(path.join(packageDir, "src", "node-plugin.ts"))};`;
		files[sandboxEntry] = `export * from ${JSON.stringify(path.join(packageDir, "src", "sandbox-fs.ts"))};`;
		const entrypoints = [sdkEntry, hostEntry, rpcEntry, pluginsEntry, sandboxEntry];
		const modules: Record<string, string> = {};
		const outputNames = new Set<string>();
		const entries = await collectBundledPiEntries();
		if (buildTarget === "desktop") {
			// The generic registry omits root wildcards, including this source
			// entry. Desktop extensions may explicitly import the headless SDK.
			entries.push({
				key: `${codingAgentPrefix}/headless`,
				binding: "bundledPiCodingAgentHeadless",
				importSpecifier: path.join(packageDir, "src", "headless.ts"),
			});
		}
		const registry = entries
			.filter(entry => exposeToNode(entry) && (buildTarget !== "desktop" || exposeToDesktop(entry)))
			.sort((a, b) => a.key.localeCompare(b.key));
		for (const entry of registry) {
			const relative = moduleEntryPath(entry.key);
			if (outputNames.has(relative)) throw new Error(`Duplicate Node SDK module entry: ${entry.key}`);
			outputNames.add(relative);
			const entrypoint = path.join(virtualRoot, relative + ".ts");
			const importSpecifier =
				entry.key === `${codingAgentPrefix}/extensibility/host-api`
					? path.join(packageDir, "src", "extensibility", "host-api.node.ts")
					: entry.importSpecifier;
			files[entrypoint] = `export * from ${JSON.stringify(importSpecifier)};`;
			entrypoints.push(entrypoint);
			modules[entry.key] = relative + ".mjs";
		}
		// Materialized wrappers keep entry directories stable across Bun versions;
		// virtual file entrypoints can otherwise be rooted against the invoking cwd.
		await Promise.all(Object.entries(files).map(([file, contents]) => Bun.write(file, contents)));
		const docs = await buildDocsIndexPayload();
		const result = await Bun.build({
			entrypoints,
			root: virtualRoot,
			outdir: outDir,
			target: "node",
			conditions: ["node"],
			format: "esm",
			metafile: true,
			splitting: true,
			naming: { entry: "[dir]/[name].mjs", chunk: "chunks/[name]-[hash].mjs" },
			external: [
				"@oh-my-pi/pi-natives",
				...Object.values(runtimeModules),
				"@huggingface/transformers",
				"fastembed",
				"onnxruntime-node",
				"koffi",
				"omp-legacy-pi-modules",
				"bun",
				"bun:ffi",
				"bun:sqlite",
				"bun:jsc",
			],
			plugins: [
				createNodeRuntimeExternalPlugin(),
				await createNodeSourceMetadataPlugin(await sourcePackageDirs()),
				createJsonParsePlugin(undefined, "node"),
			],
			define: {
				"process.env.PI_NODE_SDK": JSON.stringify("true"),
				"process.env.PI_DOCS_EMBED": JSON.stringify(docs.payload),
			},
			minify: { whitespace: true, syntax: true, identifiers: true, keepNames: true },
			throw: false,
		});
		if (!result.success) {
			const errors = result.logs.map(log =>
				log.position
					? `${log.position.file}:${log.position.line}:${log.position.column}: ${log.message}`
					: log.message,
			);
			throw new Error(`Node SDK bundle failed:\n${errors.join("\n")}`);
		}
		await Bun.write(path.join(outDir, "modules.json"), JSON.stringify({ version: 1, buildTarget, modules }));
		await writeRuntimeDependencies(outDir, result, buildTarget, virtualRoot);
		process.stdout.write(
			`Bundled ${buildTarget} Node SDK and shared worker host to ${outDir} (${registry.length} host modules)\n`,
		);
	} finally {
		await fs.rm(virtualRoot, { recursive: true, force: true });
	}
}

if (import.meta.main) await bundleNodeSdk(undefined, process.argv.includes("--desktop") ? "desktop" : "generic");

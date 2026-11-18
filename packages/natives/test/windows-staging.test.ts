/**
 * Regression for the Windows `bun install -g` update path: when an `omp`
 * process is running, bun cannot overwrite a locked
 * `node_modules/@oh-my-pi/pi-natives/native/pi_natives.win32-x64.node` during
 * package update and silently keeps the old binary next to the new ESM
 * wrapper. The next launch then throws `<sym> is not a function` deep inside
 * tool execution (see Discord report, 2026-05-14).
 *
 * Installed addons must use immutable content-identified paths, not merely a
 * package version: rebuilt Desktop profiles can have the same version and
 * filename but different exports. The integration cases load real DLLs while
 * old generations remain resident and verify the loader returns the supplied
 * generation without overwriting the locked legacy or staged files.
 *
 * Staging is off in workspace dev (`bun --cwd=packages/natives run
 * build`) and on non-Windows so the regular path is unchanged.
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	cleanupStaleNativeVersions,
	initLoaderContext,
	prepareNativeVersionDir,
	shouldStageNodeModulesAddon,
} from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

const winNodeModulesNativeDir = "C:\\Users\\Admin\\node_modules\\@oh-my-pi\\pi-natives\\native";
const winWorkspaceNativeDir = "C:\\Users\\Admin\\dev\\oh-my-pi\\packages\\natives\\native";
const posixNodeModulesNativeDir = "/home/u/proj/node_modules/@oh-my-pi/pi-natives/native";

const windowsAddonFilename = `pi_natives.win32-${process.arch}${process.arch === "x64" ? "-baseline" : ""}.node`;
const windowsAddon = path.join(import.meta.dir, "..", "native", windowsAddonFilename);
const canLoadWindowsAddon = process.platform === "win32" && existsSync(windowsAddon);

async function withInstalledAddon(test: (probe: (code: string) => Bun.SyncSubprocess<"pipe", "pipe">) => Promise<void>) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-windows-staging-"));
	const nativeDir = path.join(root, "node_modules", "@oh-my-pi", "pi-natives", "native");
	const cache = path.join(root, "cache");
	await fs.mkdir(nativeDir, { recursive: true });
	await fs.writeFile(path.join(nativeDir, "..", "package.json"), JSON.stringify(packageJson));
	for (const filename of ["loader-state.js", "embedded-addon.js", "version-sentinel.js"]) {
		await fs.copyFile(path.join(import.meta.dir, "..", "native", filename), path.join(nativeDir, filename));
	}
	const source = path.join(nativeDir, windowsAddonFilename);
	await fs.copyFile(windowsAddon, source);
	const loaderUrl = pathToFileURL(path.join(nativeDir, "loader-state.js")).href;
	try {
		await test(code =>
			Bun.spawnSync(
				[
					process.execPath,
					"--eval",
					`
					import assert from "node:assert/strict";
					import * as fs from "node:fs";
					import * as path from "node:path";
					import { createHash } from "node:crypto";
					import { createRequire } from "node:module";
					const require = createRequire(${JSON.stringify(loaderUrl)});
					import { loadNative, nativeAddonStatus } from ${JSON.stringify(loaderUrl)};
					const source = ${JSON.stringify(source)};
					const cache = ${JSON.stringify(cache)};
					const version = ${JSON.stringify(packageJson.version)};
					const filename = ${JSON.stringify(windowsAddonFilename)};
					const legacy = path.join(cache, version, filename);
					const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
					${code}
					`,
				],
				{
					env: {
						...process.env,
						PI_NATIVES_DIR: cache,
						PI_NATIVE_VARIANT: "baseline",
						PI_COMPILED: "",
						PI_DEBUG_STARTUP: "",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			),
		);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}

function expectProbeSuccess(result: Bun.SyncSubprocess<"pipe", "pipe">) {
	expect(result.exitCode, result.stderr.toString()).toBe(0);
}

describe("windows native addon staging", () => {
	it("stages only on Windows node_modules installs", () => {
		// Windows + node_modules install + npm (not compiled) → stage.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: winNodeModulesNativeDir,
			}),
		).toBe(true);

		// Windows workspace dev: nativeDir lives outside node_modules → never stage,
		// otherwise rebuilds via `bun --cwd=packages/natives run build` would be
		// shadowed by a stale cache copy.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: winWorkspaceNativeDir,
			}),
		).toBe(false);

		// Windows compiled binary: the embedded-addon extractor already populates
		// versionedDir; staging from a non-existent nativeDir would race that.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: true,
				nativeDir: winNodeModulesNativeDir,
			}),
		).toBe(false);

		// Non-Windows: bun's atomic rename works fine, no need to stage.
		expect(
			shouldStageNodeModulesAddon({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: posixNodeModulesNativeDir,
			}),
		).toBe(false);
		expect(
			shouldStageNodeModulesAddon({
				platform: "darwin",
				isCompiledBinary: false,
				nativeDir: posixNodeModulesNativeDir,
			}),
		).toBe(false);
	});

	it("classifies only Windows node_modules paths case-insensitively", () => {
		const leafPackageDir = "/tmp/node_modules/@oh-my-pi/pi-natives-darwin-arm64";
		const uppercaseNodeModulesNativeDir = "/tmp/NODE_MODULES/@oh-my-pi/pi-natives/native";
		const variantCacheKey = "__PI_NATIVE_VARIANT_CACHE";
		const previousVariantCache = process.env[variantCacheKey];
		try {
			const workspace = initLoaderContext({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: "/tmp/oh-my-pi/packages/natives/native",
				leafPackageDir,
			});
			const installed = initLoaderContext({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: "/tmp/node_modules/@oh-my-pi/pi-natives/native",
				leafPackageDir,
			});
			const uppercaseWorkspace = initLoaderContext({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: uppercaseNodeModulesNativeDir,
				leafPackageDir,
			});
			const uppercaseWindowsInstall = initLoaderContext({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: uppercaseNodeModulesNativeDir,
				leafPackageDir,
			});
			const leafCandidate = path.join(leafPackageDir, installed.addonFilenames[0]);
			const workspaceCandidate = path.join(uppercaseNodeModulesNativeDir, uppercaseWorkspace.addonFilenames[0]);

			expect(workspace.isWorkspaceLoad).toBe(true);
			expect(workspace.leafPackageDir).toBeNull();
			expect(workspace.candidates).not.toContain(leafCandidate);
			expect(installed.isWorkspaceLoad).toBe(false);
			expect(installed.leafPackageDir).toBe(leafPackageDir);
			expect(installed.candidates).toContain(leafCandidate);
			expect(installed.candidates[0]).toBe(leafCandidate);

			expect(uppercaseWorkspace.isWorkspaceLoad).toBe(true);
			expect(uppercaseWorkspace.leafPackageDir).toBeNull();
			expect(uppercaseWorkspace.candidates[0]).toBe(workspaceCandidate);

			expect(uppercaseWindowsInstall.isWorkspaceLoad).toBe(false);
			expect(uppercaseWindowsInstall.leafPackageDir).toBe(leafPackageDir);
			expect(uppercaseWindowsInstall.stageFromNodeModules).toBe(true);
		} finally {
			if (previousVariantCache === undefined) delete process.env[variantCacheKey];
			else process.env[variantCacheKey] = previousVariantCache;
		}
	});

	it.skipIf(!canLoadWindowsAddon)(
		"loads each same-version source generation while legacy and staged DLLs remain resident",
		async () => {
			await withInstalledAddon(async probe => {
				expectProbeSuccess(
					probe(`
						fs.mkdirSync(path.dirname(legacy), { recursive: true });
						fs.copyFileSync(source, legacy);
						// A PE overlay changes actual source bytes without modifying the
						// executable, ABI, release stamp, or exported native functions.
						fs.appendFileSync(legacy, "omp-old-generation");
						const oldDigest = digest(legacy);
						const oldBindings = require(legacy);
						assert.equal(oldBindings.__piNativesBuildVersion(), version);
						fs.appendFileSync(source, "omp-new-generation");
						const first = loadNative();
						const firstPath = nativeAddonStatus().path;
						assert.notEqual(first, oldBindings);
						assert.notEqual(firstPath, legacy);
						assert.equal(first.__piNativesBuildVersion(), version);
						assert.equal(typeof first.SandboxFs, "function");
						assert.equal(digest(firstPath), digest(source));
						// The package copy must be unlocked; both DLL generations stay
						// loaded while another same-version update changes its bytes.
						fs.appendFileSync(source, "omp-next-generation");
						const second = loadNative();
						const secondPath = nativeAddonStatus().path;
						assert.notEqual(second, first);
						assert.notEqual(secondPath, firstPath);
						assert.equal(second.__piNativesBuildVersion(), version);
						assert.equal(typeof second.SandboxFs, "function");
						assert.equal(digest(secondPath), digest(source));
						assert.equal(digest(legacy), oldDigest);
						assert.equal(require(legacy), oldBindings);
						assert.equal(require(firstPath), first);
						const before = fs.statSync(secondPath, { bigint: true }).mtimeNs;
						assert.equal(loadNative(), second);
						assert.equal(nativeAddonStatus().path, secondPath);
						assert.equal(fs.statSync(secondPath, { bigint: true }).mtimeNs, before);
						assert.ok(fs.existsSync(firstPath));
					`),
				);
			});
		},
		30_000,
	);

	it.skipIf(!canLoadWindowsAddon)("loads the supplied addon from a fresh isolated cache", async () => {
		await withInstalledAddon(async probe => {
			expectProbeSuccess(
				probe(`
					assert.equal(fs.existsSync(cache), false);
					const bindings = loadNative();
					assert.equal(bindings.__piNativesBuildVersion(), version);
					assert.equal(typeof bindings.SandboxFs, "function");
					assert.notEqual(nativeAddonStatus().path, source);
					assert.equal(digest(nativeAddonStatus().path), digest(source));
				`),
			);
		});
	});

	it.skipIf(!canLoadWindowsAddon)("rejects a corrupt identified cache without loading the legacy DLL", async () => {
		await withInstalledAddon(async probe => {
			expectProbeSuccess(
				probe(`
					fs.mkdirSync(path.dirname(legacy), { recursive: true });
					fs.copyFileSync(source, legacy);
					const sourceDigest = digest(source);
					const staged = path.join(cache, version, "node_modules", filename, sourceDigest, filename);
					fs.mkdirSync(path.dirname(staged), { recursive: true });
					fs.copyFileSync(source, staged);
					fs.appendFileSync(staged, "corruption");
					assert.throws(() => loadNative(), /Native addon cache integrity mismatch/);
					assert.equal(nativeAddonStatus(), null);
					assert.equal(typeof require(legacy).SandboxFs, "function");
				`),
			);
		});
	});

	it.skipIf(!canLoadWindowsAddon)("does not fall back to a valid legacy DLL when the supplied addon fails", async () => {
		await withInstalledAddon(async probe => {
			expectProbeSuccess(
				probe(`
					fs.mkdirSync(path.dirname(legacy), { recursive: true });
					fs.copyFileSync(source, legacy);
					fs.writeFileSync(source, "not a native library");
					assert.throws(() => loadNative(), /Failed to load pi_natives native addon/);
					assert.equal(nativeAddonStatus(), null);
					assert.equal(typeof require(legacy).SandboxFs, "function");
					fs.unlinkSync(source);
					assert.throws(() => loadNative(), /no supplied addon found/);
					assert.equal(nativeAddonStatus(), null);
				`),
			);
		});
	});

	it("removes only older version directories after the current native version loads", async () => {
		const nativesDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-cache-"));
		const currentMajor = Number.parseInt(packageJson.version, 10);
		const futureVersion = `${currentMajor + 1}.0.0`;
		const staleVersion = "15.10.11";
		const freshVersion = "15.10.12";
		try {
			await fs.mkdir(path.join(nativesDir, staleVersion));
			await fs.mkdir(path.join(nativesDir, freshVersion));
			await fs.mkdir(path.join(nativesDir, packageJson.version));
			await fs.mkdir(path.join(nativesDir, futureVersion));
			await fs.mkdir(path.join(nativesDir, "not-a-version"));
			await Bun.write(path.join(nativesDir, "README.txt"), "not a version directory");
			await fs.utimes(path.join(nativesDir, staleVersion), new Date(0), new Date(0));
			await fs.utimes(path.join(nativesDir, freshVersion), new Date(0), new Date(0));
			prepareNativeVersionDir(path.join(nativesDir, freshVersion));

			const removed = cleanupStaleNativeVersions({ nativesDir, currentVersion: packageJson.version });

			expect(removed.map(filePath => path.basename(filePath))).toEqual([staleVersion]);
			expect((await fs.readdir(nativesDir)).sort()).toEqual(
				["README.txt", freshVersion, packageJson.version, futureVersion, "not-a-version"].sort(),
			);
		} finally {
			await fs.rm(nativesDir, { recursive: true, force: true });
		}
	});
});

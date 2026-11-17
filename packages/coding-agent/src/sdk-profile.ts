import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type NodeSdkProfile = "core" | "full";

declare global {
	/** Replaced by the Node SDK bundler; absent in source/Bun execution. */
	const __OMP_CORE_SDK__: boolean;
}

const compiledProfile: NodeSdkProfile | undefined =
	typeof __OMP_CORE_SDK__ === "undefined" ? undefined : __OMP_CORE_SDK__ ? "core" : "full";

let profile: NodeSdkProfile = "full";

/** Read the loaded SDK's own package, never the launcher's environment or working directory. */
export function initializeNodeSdkProfile(entryUrl: string): void {
	let directory = path.dirname(fileURLToPath(entryUrl));
	for (;;) {
		let manifest: { name?: string; ompNodeSdk?: { profile?: string } } | undefined;
		try {
			manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
		}
		if (manifest?.name === "@oh-my-pi/pi-coding-agent") {
			const installedProfile =
				manifest.ompNodeSdk === undefined
					? (compiledProfile ?? "full")
					: manifest.ompNodeSdk.profile === "core"
						? "core"
						: "full";
			if (
				manifest.ompNodeSdk !== undefined &&
				compiledProfile !== undefined &&
				installedProfile !== compiledProfile
			) {
				throw new Error(
					`Node SDK profile mismatch: built ${compiledProfile}, installed ${installedProfile}. Rebuild and stage the same profile.`,
				);
			}
			profile = installedProfile;
			return;
		}
		const parent = path.dirname(directory);
		if (parent === directory) throw new Error(`Cannot locate the Node SDK package for ${entryUrl}`);
		directory = parent;
	}
}

/** Source/Bun and ordinary SDK packages retain all optional local capabilities. */
export function isCoreSdk(): boolean {
	return (compiledProfile ?? profile) === "core";
}

export function assertLocalRuntimeAvailable(feature: string): void {
	if (isCoreSdk()) {
		throwLocalRuntimeUnavailable(feature);
	}
}

/** Shared public error for capabilities removed from the compiled core graph. */
export function throwLocalRuntimeUnavailable(feature: string): never {
	throw new Error(
		`${feature} is unavailable in the core Node SDK profile. Configure a remote model/service or use the full SDK profile for offline inference.`,
	);
}

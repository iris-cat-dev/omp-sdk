import * as native from "@oh-my-pi/pi-natives";

/** Optional features compiled into the loaded native addon, independent of SDK profile. */
export interface NativeCapabilities {
	readonly smollm: boolean;
	readonly liveVoice: boolean;
	readonly wasmGrammars: boolean;
	readonly pdf: boolean;
	readonly jujutsu: boolean;
	readonly snapcompact: boolean;
	readonly audio: boolean;
	readonly localAssistance: boolean;
	readonly syntaxHighlighting: boolean;
}

const capabilityNames: readonly (keyof NativeCapabilities)[] = [
	"smollm",
	"liveVoice",
	"wasmGrammars",
	"pdf",
	"jujutsu",
	"snapcompact",
	"audio",
	"localAssistance",
	"syntaxHighlighting",
];

let compiledCapabilities: NativeCapabilities | undefined;

/** Query the addon itself; an old addon must be rebuilt, not guessed to support a feature. */
export function readNativeCapabilities(): NativeCapabilities {
	if (compiledCapabilities) return compiledCapabilities;
	const query = (native as typeof native & { nativeCapabilities?: () => NativeCapabilities }).nativeCapabilities;
	if (typeof query !== "function") {
		throw new Error(
			"The native addon cannot report its build capabilities. Rebuild with `bun --cwd=packages/natives run build:bindings` (full) or `build:desktop` (Desktop), then restage the SDK.",
		);
	}
	const capabilities = query();
	if (!capabilities || capabilityNames.some(name => typeof capabilities[name] !== "boolean")) {
		throw new Error(
			"The native addon reports an incompatible capability contract. Rebuild the native addon and restage the SDK.",
		);
	}
	compiledCapabilities = Object.freeze(capabilities);
	return compiledCapabilities;
}

export function assertNativeCapability(capability: keyof NativeCapabilities, feature: string): void {
	if (!readNativeCapabilities()[capability]) {
		throw new Error(
			`${feature} is unavailable in this native build. Use the full generic SDK/CLI build for this feature; changing the Desktop SDK profile does not restore native capabilities.`,
		);
	}
}

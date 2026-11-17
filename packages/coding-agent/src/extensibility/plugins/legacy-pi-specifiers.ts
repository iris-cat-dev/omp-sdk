// Historical Pi package scopes resolve to the host's canonical module instance.
export const CANONICAL_PI_SCOPE = "@oh-my-pi";
const PI_SCOPE_ALIASES = ["oh-my-pi", "mariozechner", "earendil-works"] as const;
export const PI_PACKAGE_NAMES = [
	"pi-agent-core",
	"pi-ai",
	"pi-catalog",
	"pi-coding-agent",
	"pi-natives",
	"pi-tui",
	"pi-utils",
] as const;

export const LEGACY_PI_SPECIFIER_FILTER = new RegExp(
	`^@(?:${PI_SCOPE_ALIASES.join("|")})/(?:${PI_PACKAGE_NAMES.join("|")})(?:/.*)?$`,
);

// Upstream pi-ai subpaths moved in the canonical package layout.
const PI_SUBPATH_REMAPS: ReadonlyMap<string, string> = new Map<string, string>([
	["pi-ai/utils/oauth", "pi-ai/oauth"],
	["pi-ai/utils/oauth/", "pi-ai/oauth/"],
	["pi-ai/compat", "pi-ai"],
]);

function remapLegacyPiSubpath(rest: string): string {
	const exact = PI_SUBPATH_REMAPS.get(rest);
	if (exact) return exact;
	for (const [from, to] of PI_SUBPATH_REMAPS) {
		if (from.endsWith("/") && rest.startsWith(from)) return `${to}${rest.slice(from.length)}`;
	}
	return rest;
}

export function remapLegacyPiSpecifier(specifier: string): string | null {
	if (!LEGACY_PI_SPECIFIER_FILTER.test(specifier)) return null;
	const slashIdx = specifier.indexOf("/", 1);
	return `${CANONICAL_PI_SCOPE}/${remapLegacyPiSubpath(specifier.slice(slashIdx + 1))}`;
}

// TypeBox-only submodules are deliberately left to the plugin's dependencies.
export const TYPEBOX_SPECIFIER_FILTER = /^(?:@sinclair\/typebox|typebox)$/;

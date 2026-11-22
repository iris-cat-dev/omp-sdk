export interface PlanModeState {
	enabled: boolean;
	planFilePath: string;
	workflow?: "parallel" | "iterative";
	reentry?: boolean;
	/** Desktop RPC yields on proposal and restricts execution to planning tools. */
	desktop?: { awaitingReview: boolean };
}

/** Built-in tools whose planning surface doesn't mutate the workspace. */
const DESKTOP_PLAN_TOOLS: Readonly<Record<string, true>> = {
	read: true,
	glob: true,
	grep: true,
	find: true,
	ast_grep: true,
	ask: true,
	think: true,
	edit: true,
	write: true,
};

export function isDesktopPlanTool(name: string): boolean {
	return Object.hasOwn(DESKTOP_PLAN_TOOLS, name);
}

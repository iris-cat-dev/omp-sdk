import "./node-platform";
import { resolveProfileEnv } from "@oh-my-pi/pi-utils/dirs";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { parsePluginArgs, runPluginCommand } from "./cli/plugin-cli";
import { initializeNodeSdk } from "./node-bootstrap";

initializeNodeSdk(import.meta.url);

/** Run a full `plugin` argv in a dedicated Node process, preserving CLI output and exit semantics. */
export async function runNodePluginCommand(args: readonly string[]): Promise<void> {
	// The dirs singleton defers invalid environment errors to its entrypoint.
	resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE);
	const command = parsePluginArgs([...args]);
	if (!command) throw new Error("Node SDK plugin commands must start with 'plugin'");
	await initTheme();
	await runPluginCommand(command);
}

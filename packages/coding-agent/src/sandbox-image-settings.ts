import { createRequire } from "node:module";
import * as path from "node:path";
import type { ModelRegistry, ProviderConfigInput } from "./config/model-registry";
import type { SandboxImagePreferences } from "./sandbox-image";
import type { ImageGenParams } from "./tools/image-gen";

/** Invoke only Desktop's native image preferences integration with a narrow settings API. */
export async function openSandboxImageSettings(adapterPath: string, registry: ModelRegistry): Promise<SandboxImagePreferences> {
  if (!path.isAbsolute(adapterPath)) throw new Error("Image settings adapter must be absolute");
  const module = createRequire(import.meta.url)(adapterPath) as { default?: (api: unknown) => void };
  if (typeof module.default !== "function") throw new Error("Image settings adapter is invalid");
  const start: Array<(event: unknown, context: unknown) => Promise<void>> = [];
  const shutdown: Array<() => void> = [];
  const calls: Array<(event: unknown) => { block?: boolean; reason?: string; input?: ImageGenParams } | undefined> = [];
  let enabled = false;
  const dispose = () => { for (const handler of shutdown) handler(); };
  try {
    module.default(Object.freeze({
      on(event: string, handler: unknown) {
        if (typeof handler !== "function") throw new Error("Invalid image settings handler");
        if (event === "session_start") start.push(handler as typeof start[number]);
        else if (event === "session_shutdown") shutdown.push(handler as typeof shutdown[number]);
        else if (event === "tool_call") calls.push(handler as typeof calls[number]);
        else throw new Error("Sandbox image settings hooks denied");
      },
      getAllTools: () => [{ name: "generate_image" }],
      async setToolEnabled(name: string, value: boolean) { if (name !== "generate_image") throw new Error("Sandbox image settings tool access denied"); enabled = value; },
      registerProvider: (name: string, config: ProviderConfigInput) => registry.registerProvider(name, config, "<trusted-image-settings>"),
      unregisterProvider: (name: string) => registry.unregisterProvider(name),
    }));
    for (const handler of start) await handler(undefined, { modelRegistry: registry });
    return {
      prepare(toolCallId, params) {
        let input = params;
        for (const handler of calls) { const result = handler({ toolName: "generate_image", toolCallId, input }); if (result?.block) throw new Error(result.reason ?? "Host image generation is disabled"); if (result?.input) input = result.input; }
        if (!enabled) throw new Error("Host image generation is disabled");
        return input;
      },
      dispose,
    };
  } catch (error) {
    try { dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Sandbox image settings initialization and cleanup failed", { cause: error }); }
    throw error;
  }
}

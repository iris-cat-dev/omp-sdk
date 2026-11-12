import { randomUUID } from "node:crypto";
import { parseImageMetadata, prompt } from "@oh-my-pi/pi-utils";
import { type } from "@oh-my-pi/omptype";
import type { ModelRegistry } from "./config/model-registry";
import type { Settings } from "./config/settings";
import type { ToolDefinition } from "./extensibility/extensions/types";
import type { SandboxFs } from "./sandbox-fs";
import { createImageGenTool, imageGenSchema, type ImageGenParams } from "./tools/image-gen";
import sandboxImageDescription from "./prompts/tools/sandbox-image.md" with { type: "text" };

/** Host-only settings gate, never an arbitrary tool registration API. */
export interface SandboxImagePreferences {
  prepare(toolCallId: string, params: ImageGenParams): ImageGenParams;
  dispose(): void;
}
export type SandboxImageSettings = (registry: ModelRegistry) => Promise<SandboxImagePreferences>;
const MAX_IMAGE_BYTES = 35 * 1024 * 1024;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const sandboxInputImageSchema = type({ path: type("string").describe("sandbox-relative input image path") }).onUndeclaredKey("reject");
export const sandboxImageSchema = imageGenSchema.omit("input").merge({ "input?": sandboxInputImageSchema.array() });

export function sandboxImageTool(files: SandboxFs, registry: ModelRegistry, settings: Settings, preferences?: SandboxImagePreferences): ToolDefinition {
  return {
    name: "generate_image", label: "Generate image", description: prompt.render(sandboxImageDescription), parameters: sandboxImageSchema,
    async execute(id, args, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!preferences) throw new Error("Host image generation settings are unavailable");
      const params = sandboxImageSchema.assert(args);
      const input = (params.input ?? []).map(image => {
        if (!image.path) throw new Error("Input images require a sandbox-relative path");
        let bytes: Buffer;
        try { bytes = files.read(image.path, MAX_IMAGE_BYTES); } catch (error) { throw new Error("Sandbox image access denied", { cause: error }); }
        const mimeType = parseImageMetadata(bytes)?.mimeType;
        if (!mimeType || !EXTENSIONS[mimeType]) throw new Error("Unsupported sandbox input image");
        return { data: bytes.toString("base64"), mime_type: mimeType };
      });
      const prepared = preferences.prepare(id, { ...params, input });
      const native = createImageGenTool(async (_model, result) => {
        signal?.throwIfAborted();
        if (!result.images.length) throw new Error("Image generation returned no image data");
        const decoded = result.images.map(image => {
          const bytes = Buffer.from(image.data, "base64");
          const mimeType = parseImageMetadata(bytes)?.mimeType;
          if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || !mimeType || !EXTENSIONS[mimeType]) throw new Error("Image generation returned invalid image data");
          return { bytes, mimeType, path: `.qqbot-media/generated/${randomUUID()}.${EXTENSIONS[mimeType]}` };
        });
        const written: string[] = [];
        try {
          files.mkdir(".qqbot-media"); files.mkdir(".qqbot-media/generated");
          for (const image of decoded) { signal?.throwIfAborted(); files.write(image.path, image.bytes, { exclusive: true }); written.push(image.path); }
          signal?.throwIfAborted();
        } catch (error) { for (const path of written) files.remove(path); throw error; }
        const generatedImages = decoded.map(({ path, mimeType }) => ({ path, mimeType, name: path.split("/").at(-1)! }));
        return { content: [{ type: "text", text: generatedImages.map(image => image.path).join("\n") }], details: { imageCount: generatedImages.length, generatedImagesSource: "omp-sandbox-image" as const, generatedImages, images: decoded.map(({ mimeType }, index) => ({ data: result.images[index]!.data, mimeType })) } };
      });
      try {
        return await native.execute(id, prepared, undefined, { sessionManager: ctx.sessionManager, modelRegistry: registry, model: undefined, settings, isIdle: ctx.isIdle, hasQueuedMessages: ctx.hasPendingMessages, abort: ctx.abort }, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error("Host image generation failed", { cause: error });
      }
    },
  };
}

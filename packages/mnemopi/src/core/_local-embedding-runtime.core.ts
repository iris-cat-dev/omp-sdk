import type { LocalEmbeddingModel, LocalModelInitOptions } from "./embeddings";

function unavailable(): never {
	throw new Error(
		"Local memory embeddings are unavailable in the core Node SDK profile. Configure remote embeddings or use the full SDK profile.",
	);
}

export async function defaultLocalModelInitializer(_options: LocalModelInitOptions): Promise<LocalEmbeddingModel> {
	return unavailable();
}

export async function quarantineCorruptModelFile(_message: string, _cacheDir?: string): Promise<boolean> {
	return unavailable();
}

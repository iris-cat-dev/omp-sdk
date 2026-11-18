import * as path from "node:path";
import { getTinyModelsCacheDir } from "@oh-my-pi/pi-utils";

/** Pinned files shared by the optional downloader and public model metadata. */
export const SMOLLM_LABEL = "SmolLM2-135M";
export const SMOLLM_REPO = "HuggingFaceTB/SmolLM2-135M";
const SMOLLM_REVISION = "93efa2f097d58c2a74874c7e644dbc9b0cee75a2";
const GGUF_REPO = "QuantFactory/SmolLM2-135M-GGUF";
const GGUF_REVISION = "d948db3614be18259a175aafd7689a70f1cb4e2f";

export interface WeightFile {
	repo: string;
	revision: string;
	name: string;
	size: number;
	sha256: string;
}

export const SMOLLM_FILES: readonly WeightFile[] = [
	{
		repo: SMOLLM_REPO,
		revision: SMOLLM_REVISION,
		name: "config.json",
		size: 704,
		sha256: "1d556eab73b69c7f11f64c557a2f9c6f440bd4c6b89bb2584a6b498c92603843",
	},
	{
		repo: SMOLLM_REPO,
		revision: SMOLLM_REVISION,
		name: "tokenizer.json",
		size: 2_104_556,
		sha256: "9ca9acddb6525a194ec8ac7a87f24fbba7232a9a15ffa1af0c1224fcd888e47c",
	},
	{
		repo: GGUF_REPO,
		revision: GGUF_REVISION,
		name: "SmolLM2-135M.Q8_0.gguf",
		size: 144_810_464,
		sha256: "b761d9ccdfce67726e41ca2ef30e9dfbcf6a32ca2aaef47df5c049ec362d04cd",
	},
];

export const SMOLLM_TOTAL_BYTES = SMOLLM_FILES.reduce((sum, file) => sum + file.size, 0);

export function getSmolLmModelDir(): string {
	return path.join(getTinyModelsCacheDir(), "predict", SMOLLM_REPO.replace("/", "--"));
}

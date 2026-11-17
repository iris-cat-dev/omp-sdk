import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageNodeSdk } from "./stage-node-sdk.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageName = "@oh-my-pi/pi-coding-agent";
const minimumNodeVersion = "24.14.0";
const supportedTargets = ["darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"];
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const saveJson = async (file, value) => writeFile(file, `${JSON.stringify(value, null, 2)}\n`);

export async function readNodeSdkReleaseConfig() {
  const config = await json(path.join(root, "sdk", "node-release.json"));
  const sdk = await json(path.join(root, "packages", "coding-agent", "package.json"));
  if (
    config.schemaVersion !== 1 || config.repository !== "iris-cat-dev/omp-sdk" ||
    config.buildTarget !== "desktop" || config.profile !== "core" ||
    sdk.name !== packageName || !/^\d+\.\d+\.\d+$/u.test(sdk.version) ||
    !new RegExp(`^sdk-v${sdk.version.replaceAll(".", "\\.")}-desktop-core\\.\\d+$`, "u").test(config.tag) ||
    !Array.isArray(config.targets) || config.targets.length !== supportedTargets.length ||
    new Set(config.targets).size !== config.targets.length ||
    supportedTargets.some((target) => !config.targets.includes(target))
  ) throw new Error("Incompatible SDK release configuration or package version.");
  return { ...config, packageName, version: sdk.version, minimumNodeVersion };
}

export function nodeSdkAssetName(config, target) {
  if (!config.targets.includes(target)) throw new Error(`Unsupported SDK release target: ${target}`);
  return `omp-sdk-${config.buildTarget}-${config.profile}-${target}.tgz`;
}

export async function hashNodeSdkArchive(file) {
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk);
    sha512.update(chunk);
    size += chunk.length;
  }
  if (size === 0) throw new Error(`Empty SDK archive: ${file}`);
  return { sha256: sha256.digest("hex"), size, integrity: `sha512-${sha512.digest("base64")}` };
}

function tar(file, ...args) {
  const result = spawnSync("tar", [...args, file], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Cannot read SDK archive ${file}: ${result.stderr}`);
  return result.stdout;
}

function archiveJson(file, member) {
  const result = spawnSync("tar", ["-xOf", file, member], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Missing SDK archive metadata ${member}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

export function validateNodeSdkArchive(file, config, target) {
  const sdk = archiveJson(file, "package/package.json");
  const modules = archiveJson(file, "package/dist/node/modules.json");
  const runtime = archiveJson(file, "package/dist/node/runtime-dependencies.json");
  if (sdk.name !== config.packageName || sdk.version !== config.version ||
      sdk.ompNodeSdk?.target !== config.buildTarget || sdk.ompNodeSdk?.profile !== config.profile ||
      modules.version !== 1 || modules.buildTarget !== config.buildTarget || modules.profile !== config.profile ||
      runtime.version !== 1 || runtime.buildTarget !== config.buildTarget || runtime.profile !== config.profile)
    throw new Error(`Incompatible SDK archive metadata for ${target}.`);
  const members = new Set(tar(file, "-tzf").trim().split("\n"));
  const nativePrefix = "package/node_modules/@oh-my-pi/pi-natives/native/pi_natives.";
  const expectedNative = `${nativePrefix}${target}${target.endsWith("-x64") ? "-baseline" : ""}.node`;
  if (!members.has(expectedNative) || [...members].some((member) =>
    member.startsWith(nativePrefix) && member.endsWith(".node") && member !== expectedNative))
    throw new Error(`SDK ${target} must contain only its matching isolated addon (x64 baseline).`);
  for (const member of ["host.mjs", "rpc.mjs", "plugins.mjs", ...Object.values(modules.modules ?? {})]) {
    if (typeof member !== "string" || !members.has(`package/dist/node/${member}`))
      throw new Error(`SDK archive omits worker/module entry: ${member}`);
  }
}

/** Stage only the current host's real, already-built native dependency closure. */
export async function stageHostNodeSdkRelease(outputDir) {
  const config = await readNodeSdkReleaseConfig();
  const target = `${process.platform}-${process.arch}`;
  if (!config.targets.includes(target) ||
      (process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime))
    throw new Error(`SDK releases require a supported matching native host (Linux glibc): ${target}`);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "omp-sdk-release-stage-"));
  try {
    const staged = await stageNodeSdk(path.join(root, "packages", "coding-agent"), temporary, config);
    if (staged.version !== config.version || staged.minimumNodeVersion !== config.minimumNodeVersion)
      throw new Error("Staged SDK identity differs from pinned release configuration.");
    validateNodeSdkArchive(staged.archive, config, target);
    const asset = nodeSdkAssetName(config, target);
    await mkdir(outputDir, { recursive: true });
    await cp(staged.archive, path.join(outputDir, asset));
    const record = { ...staged, archive: undefined, directory: undefined,
      asset, ...await hashNodeSdkArchive(path.join(outputDir, asset)) };
    await saveJson(path.join(outputDir, `${target}.json`), record);
    return record;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Index generation is gated on every exact tarball having passed an installed smoke. */
export async function createNodeSdkReleaseIndex(directory) {
  const config = await readNodeSdkReleaseConfig();
  const expectedAssets = new Set(config.targets.map((target) => nodeSdkAssetName(config, target)));
  const expectedRecords = new Set(config.targets.flatMap((target) => [`${target}.json`, `${target}.smoke.json`]));
  for (const entry of await readdir(directory)) {
    if ((entry.endsWith(".tgz") && !expectedAssets.has(entry)) ||
        (entry.endsWith(".json") && entry !== "omp-sdk-release.json" && !expectedRecords.has(entry)))
      throw new Error(`Unexpected or duplicate SDK target artifact: ${entry}`);
  }
  const targets = {};
  for (const target of config.targets) {
    const record = await json(path.join(directory, `${target}.json`));
    const smoke = await json(path.join(directory, `${target}.smoke.json`));
    const asset = nodeSdkAssetName(config, target);
    if (record.schemaVersion !== 1 || record.packageName !== config.packageName ||
        record.version !== config.version || record.minimumNodeVersion !== config.minimumNodeVersion ||
        record.buildTarget !== config.buildTarget || record.profile !== config.profile ||
        `${record.platform}-${record.arch}` !== target || record.asset !== asset)
      throw new Error(`Incompatible SDK target record: ${target}`);
    const file = path.join(directory, asset);
    validateNodeSdkArchive(file, config, target);
    const bytes = await hashNodeSdkArchive(file);
    if (record.sha256 !== bytes.sha256 || record.size !== bytes.size || record.integrity !== bytes.integrity ||
        smoke.schemaVersion !== 1 || smoke.target !== target || smoke.sha256 !== bytes.sha256 ||
        smoke.nodeVersion !== config.minimumNodeVersion)
      throw new Error(`SDK target bytes or installed-smoke receipt do not match: ${target}`);
    targets[target] = { asset, ...bytes };
  }
  const index = { schemaVersion: 1, packageName: config.packageName, version: config.version,
    minimumNodeVersion: config.minimumNodeVersion, buildTarget: config.buildTarget, profile: config.profile, targets };
  await saveJson(path.join(directory, "omp-sdk-release.json"), index);
  await writeFile(path.join(directory, "release-notes.txt"), nodeSdkReleaseNotes(config, index));
  return index;
}

export function nodeSdkReleaseNotes(config, index) {
  const inventory = Object.entries(index.targets).map(([target, asset]) =>
    `- \`${target}\`: \`${asset.asset}\` (${asset.size} bytes), SHA-256 \`${asset.sha256}\``).join("\n");
  return `# Node SDK ${config.version} — Desktop core / 桌面核心版\n\n` +
    `## 中文\n\n` +
    `- Desktop 远程后端可使用独立的、按目标平台分发的 Node SDK，无需安装 Bun。压缩包包含 core 工作器、模块和资源。\n` +
    `- 需要 Node.js >= ${config.minimumNodeVersion}；支持 macOS x64/arm64 与 Linux glibc x64/arm64。x64 使用现有 x86-64-v2 baseline，不要求 AVX2 modern 指令集。Windows 和 musl 主机不受支持。\n` +
    `- 保留远程/API 模型、原生文件与 Shell 工具、浏览器、RPC 和会话持久化。不包含本地模型推理、本地向量模型、离线语音，以及原生 PDF、Jujutsu、音频、本地辅助和 syntect TUI 高亮；Desktop 的 Lezer 高亮不受影响。\n` +
    `- 四个安装用 npm 压缩包均携带对应平台的真实原生依赖；索引记录每个文件的名称、大小、SHA-256 与 SHA-512 完整性。SDK npm 版本仍为 ${config.version}，这不是 npm 或上游 CLI/二进制发布。\n` +
    `- 正式发布前必须核对索引与全部四个平台资产。Desktop 固定使用 \`${config.repository}@${config.tag}\`，不会回退到 latest 或本机 SDK。\n\n` +
    `## English\n\n` +
    `- Desktop remote backends can use standalone, target-specific Node SDK assets without installing Bun. Archives include the core worker, module and resource graph.\n` +
    `- Requires Node.js >= ${config.minimumNodeVersion}. Supports macOS x64/arm64 and Linux glibc x64/arm64. x64 uses the existing x86-64-v2 baseline, not the AVX2-only modern addon. Windows and musl hosts are unsupported.\n` +
    `- Remote/API models, native file and Shell tools, browser support, RPC and saved sessions remain available. Local model inference, local embeddings, offline speech, and native PDF, Jujutsu, audio, local assistance and syntect TUI highlighting are not included; Desktop's Lezer highlighting is unchanged.\n` +
    `- All four installable npm archives include their real matching native dependencies. The index records each asset's name, byte size, SHA-256 and SHA-512 integrity. The SDK npm version remains ${config.version}; this is not an npm or upstream CLI/binary release.\n` +
    `- Review the index and all four platform assets before publication. Desktop pins \`${config.repository}@${config.tag}\`; there is no latest or local-SDK fallback.\n\n` +
    `## Assets / 资产\n\n${inventory}\n\n**完整更新记录 / Full changelog**: https://github.com/${config.repository}/commits/${config.tag}/\n`;
}

/** Upload only complete SDK assets to a draft; publication remains a human review step. */
export async function uploadNodeSdkDraft(directory) {
  const config = await readNodeSdkReleaseConfig();
  if (process.env.GITHUB_REPOSITORY !== config.repository || !process.env.GITHUB_TOKEN || !process.env.GITHUB_SHA)
    throw new Error("SDK draft upload requires this repository's Actions GITHUB_TOKEN and commit SHA.");
  const index = await createNodeSdkReleaseIndex(directory);
  const headers = { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  const apiRoot = `https://api.github.com/repos/${config.repository}`;
  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
    if (!response.ok) throw new Error(`GitHub SDK release API ${response.status}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }
  // Draft releases are omitted by the tag lookup endpoint; enumerate authenticated releases.
  let release;
  for (let page = 1; ; page++) {
    const releases = await api(`${apiRoot}/releases?per_page=100&page=${page}`);
    release = releases.find((candidate) => candidate.tag_name === config.tag);
    if (release || releases.length < 100) break;
  }
  if (release && !release.draft) throw new Error(`Refusing to modify a published SDK release: ${config.tag}`);
  if (release && release.target_commitish !== process.env.GITHUB_SHA)
    throw new Error("Existing SDK draft belongs to a different commit; use a new pinned release tag.");
  const incomplete = "SDK-only draft: incomplete until all four platform assets and the index are uploaded and verified.\n\n" +
    "仅 SDK 发布草稿：四个平台资产及索引全部上传并校验前不完整，不得正式发布。\n";
  const body = { tag_name: config.tag, target_commitish: process.env.GITHUB_SHA,
    name: `Node SDK ${config.version} — Desktop core / 桌面核心版`, body: incomplete, draft: true };
  release = await api(release ? `${apiRoot}/releases/${release.id}` : `${apiRoot}/releases`, {
    method: release ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const assets = await api(`${apiRoot}/releases/${release.id}/assets?per_page=100`);
  const names = [...Object.values(index.targets).map((target) => target.asset), "omp-sdk-release.json"];
  if (assets.some((asset) => !names.includes(asset.name))) throw new Error("SDK draft contains unrelated assets; refusing to replace them.");
  // Remove a previous completeness index first. Failed uploads must never retain a ready-looking index.
  for (const asset of [...assets].sort((a, b) => Number(b.name === "omp-sdk-release.json") - Number(a.name === "omp-sdk-release.json")))
    await api(`${apiRoot}/releases/assets/${asset.id}`, { method: "DELETE" });
  for (const name of names) {
    const file = path.join(directory, name);
    const { size } = await stat(file);
    const upload = await api(`${release.upload_url.replace(/\{.*$/u, "")}?name=${encodeURIComponent(name)}`, {
      method: "POST", headers: { "Content-Type": name.endsWith(".tgz") ? "application/gzip" : "application/json",
        "Content-Length": String(size) }, body: createReadStream(file), duplex: "half",
    });
    const downloaded = await fetch(upload.url, { headers: { ...headers, Accept: "application/octet-stream" } });
    if (!downloaded.ok || !downloaded.body) throw new Error(`Cannot verify uploaded SDK asset ${name}: ${downloaded.status}`);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of downloaded.body) { hash.update(chunk); bytes += chunk.length; }
    const expected = await hashNodeSdkArchive(file);
    if (bytes !== expected.size || hash.digest("hex") !== expected.sha256)
      throw new Error(`Uploaded SDK asset differs from tested bytes: ${name}`);
  }
  const uploaded = await api(`${apiRoot}/releases/${release.id}/assets?per_page=100`);
  if (uploaded.length !== names.length || names.some((name) => uploaded.filter((asset) => asset.name === name).length !== 1))
    throw new Error("SDK draft upload is incomplete or duplicated.");
  await api(`${apiRoot}/releases/${release.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: nodeSdkReleaseNotes(config, index), draft: true }) });
  return release.html_url;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, output = "sdk-release-dist"] = process.argv.slice(2);
  const directory = path.resolve(output);
  if (command === "stage") console.log(JSON.stringify(await stageHostNodeSdkRelease(directory), null, 2));
  else if (command === "index") console.log(JSON.stringify(await createNodeSdkReleaseIndex(directory), null, 2));
  else if (command === "draft") console.log(await uploadNodeSdkDraft(directory));
  else throw new Error("Usage: node scripts/release-node-sdk.mjs <stage|index|draft> [output-directory]");
}

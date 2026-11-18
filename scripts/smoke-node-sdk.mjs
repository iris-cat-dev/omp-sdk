import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashNodeSdkArchive, nodeSdkAssetName, readNodeSdkReleaseConfig, validateNodeSdkArchive } from "./release-node-sdk.mjs";

const scripts = path.dirname(fileURLToPath(import.meta.url));

/** Install the exact release tarball with npm ci in an isolated, offline project. */
export async function smokeNodeSdkArchive(directory) {
  const config = await readNodeSdkReleaseConfig();
  const target = `${process.platform}-${process.arch}`;
  if (process.versions.node !== config.minimumNodeVersion)
    throw new Error(`SDK release smoke requires exact Node.js ${config.minimumNodeVersion}, got ${process.versions.node}.`);
  const asset = nodeSdkAssetName(config, target);
  const file = path.join(directory, asset);
  const receipt = path.join(directory, `${target}.smoke.json`);
  // Never retain a previous successful receipt when a new smoke fails.
  await rm(receipt, { force: true });
  validateNodeSdkArchive(file, config, target);
  const bytes = await hashNodeSdkArchive(file);
  const project = await mkdtemp(path.join(os.tmpdir(), "omp-sdk-installed-smoke-"));
  try {
    const home = path.join(project, "home");
    await mkdir(home);
    const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: path.join(home, "agent"),
      PI_CONFIG_DIR: ".omp", PI_PROFILE: "", XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"), XDG_CACHE_HOME: path.join(home, "cache"),
      OMP_SDK_SMOKE_VERSION: config.version, NODE_PATH: "", NODE_OPTIONS: "",
      npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false" };
    await cp(file, path.join(project, "omp-sdk.tgz"));
    await writeFile(path.join(project, "package.json"), `${JSON.stringify({
      name: "omp-sdk-installed-smoke", version: "0.0.0", private: true, type: "module",
      dependencies: { [config.packageName]: "file:omp-sdk.tgz" },
    }, null, 2)}\n`);
    await cp(path.join(scripts, "node-sdk-installed-probe.mjs"), path.join(project, "probe.mjs"));
    await cp(path.join(scripts, "node-sdk-installed-rpc-probe.mjs"), path.join(project, "node-sdk-installed-rpc-probe.mjs"));
    function run(command, args) {
      const result = spawnSync(command, args, { cwd: project, env, stdio: "inherit", timeout: 120_000 });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`Installed SDK smoke failed: ${command} ${args.join(" ")} (${result.status})`);
    }
    run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"]);
    const lock = JSON.parse(await readFile(path.join(project, "package-lock.json"), "utf8"));
    assert.equal(lock.packages[`node_modules/${config.packageName}`].integrity, bytes.integrity);
    run("npm", ["ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"]);
    run(process.execPath, ["probe.mjs"]);
    const after = await hashNodeSdkArchive(file);
    assert.deepEqual(after, bytes, "SDK archive changed during installed smoke");
    const result = { schemaVersion: 1, target, sha256: bytes.sha256, nodeVersion: process.versions.node };
    await writeFile(receipt, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await smokeNodeSdkArchive(path.resolve(process.argv[2] ?? "sdk-release-dist")), null, 2));

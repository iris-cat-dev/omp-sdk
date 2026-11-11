import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@oh-my-pi/pi-utils";
import * as discovery from "../src/discovery/helpers";
import { PluginManager } from "../src/extensibility/plugins/manager";

let root: string;
let user: string;
let project: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-management-"));
  user = path.join(root, "profile", "plugins");
  project = path.join(root, "workspace", ".omp", "plugins");
  spyOn(piUtils, "getPluginsDir").mockReturnValue(user);
  spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(user, "omp-plugins.lock.json"));
  spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(user, "package.json"));
  spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(path.join(user, "node_modules"));
  spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(root, "overrides.json"));
  spyOn(discovery, "resolveActiveProjectRegistryPath").mockResolvedValue(path.join(project, "installed_plugins.json"));
  for (const [scope, base] of [["user", user], ["project", project]] as const) {
    const installPath = path.join(base, "cache", "fixture");
    await Bun.write(path.join(installPath, "package.json"), JSON.stringify({ name: "fixture", version: "1", omp: { version: "1", features: { defaultFeature: { default: true }, optional: {} }, settings: { token: { type: "string", secret: true, default: "default-secret" }, count: { type: "number", min: 0, default: 1 }, label: { type: "string" } } } }));
    await Bun.write(path.join(base, "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "fixture@exact-market": [{ scope, installPath, version: "1" }] } }));
    await Bun.write(path.join(base, "omp-plugins.lock.json"), JSON.stringify({ plugins: { fixture: { version: "1", enabled: false, enabledFeatures: null } }, settings: { fixture: { token: `${scope}-secret`, count: scope === "user" ? 2 : 3, undeclaredCredential: "unknown-secret" } } }));
  }
});
afterEach(async () => { mock.restore(); await piUtils.removeWithRetries(root); });

describe("native management", () => {
  test("projects schema-only values and secret configured markers from the exact profile and scope", async () => {
    const state = await new PluginManager(root).managePlugin("fixture@exact-market", "project");
    expect(state.name).toBe("fixture@exact-market");
    expect(state.scope).toBe("project");
    expect(state.settings).toEqual({ count: 3 });
    expect(state.secretConfigured).toEqual({ token: true });
    expect(JSON.stringify(state)).not.toMatch(/project-secret|user-secret|default-secret|unknown-secret/);
    expect(state.enabledFeatures).toBeNull();
    expect(state.effectiveFeatures).toEqual(["defaultFeature"]);
  });
  test("empty feature selection differs from defaults and changes only the selected installed scope", async () => {
    const manager = new PluginManager(root);
    const result = await manager.managePlugin("fixture@exact-market", "project", { enabledFeatures: [], settings: { count: 4 } });
    expect(result.enabledFeatures).toEqual([]);
    expect(result.effectiveFeatures).toEqual([]);
    expect(result.settings.count).toBe(4);
    const userState = await manager.managePlugin("fixture@exact-market", "user");
    expect(userState.settings.count).toBe(2);
    expect(userState.enabledFeatures).toBeNull();
    const persisted = await Bun.file(path.join(project, "omp-plugins.lock.json")).json();
    expect(persisted.plugins.fixture.enabled).toBe(false);
    expect(persisted.settings.fixture.token).toBe("project-secret");
    expect((await manager.managePlugin("fixture@exact-market", "project", { enabledFeatures: null })).effectiveFeatures).toEqual(["defaultFeature"]);
  });
  test("rejects secret and schema-invalid writes before changing existing native state", async () => {
    const manager = new PluginManager(root);
    const before = await Bun.file(path.join(project, "omp-plugins.lock.json")).text();
    await expect(manager.managePlugin("fixture@exact-market", "project", { settings: { token: "new-secret" } })).rejects.toThrow("Secret input is unavailable");
    await expect(manager.managePlugin("fixture@exact-market", "project", { settings: { count: -1 } })).rejects.toThrow("Invalid native setting");
    await expect(manager.managePlugin("fixture@exact-market", "project", { enabledFeatures: ["absent"] })).rejects.toThrow("Unknown native feature");
    expect(await Bun.file(path.join(project, "omp-plugins.lock.json")).text()).toBe(before);
  });
  test("retains project overrides while editing the selected installation's desired state", async () => {
    const overrides = { features: { fixture: ["optional"] }, settings: { fixture: { count: 99, token: "override-secret" } } };
    await Bun.write(path.join(root, "overrides.json"), JSON.stringify(overrides));
    const result = await new PluginManager(root).managePlugin("fixture@exact-market", "user", { enabledFeatures: [], settings: { count: 5 } });
    expect(result.enabledFeatures).toEqual([]);
    expect(result.effectiveFeatures).toEqual(["optional"]);
    expect(result.featuresOverridden).toBe(true);
    expect(result.overriddenSettings).toEqual(["count", "token"]);
    expect(result.settings.count).toBe(5);
    expect(JSON.stringify(result)).not.toContain("override-secret");
    expect(await Bun.file(path.join(root, "overrides.json")).json()).toEqual(overrides);
  });
  test("refuses malformed native config instead of replacing it with an empty registry", async () => {
    const lock = path.join(project, "omp-plugins.lock.json");
    await Bun.write(lock, "{broken-config");
    await expect(new PluginManager(root).managePlugin("fixture@exact-market", "project", { settings: { count: 5 } })).rejects.toThrow();
    expect(await Bun.file(lock).text()).toBe("{broken-config");
  });
  test("list exposes linked source status consistent with native no-upgrade behavior", async () => {
    const localPath = path.join(user, "node_modules", "local-plugin");
    await Bun.write(path.join(localPath, "package.json"), JSON.stringify({ name: "local-plugin", version: "1" }));
    const lock = path.join(user, "omp-plugins.lock.json");
    const config = await Bun.file(lock).json();
    config.plugins["local-plugin"] = { version: "1", enabled: false, enabledFeatures: [] };
    await Bun.write(lock, JSON.stringify(config));
    const manager = new PluginManager(root);
    const plugin = (await manager.list()).find(item => item.name === "local-plugin");
    expect(plugin).toMatchObject({ linked: true, source: localPath, scope: "user", enabled: false, enabledFeatures: [] });
    await expect(manager.validateUpgrade("local-plugin")).rejects.toThrow("nothing to upgrade");
  });
});

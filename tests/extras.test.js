"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  applyChange,
  createSettingsStore,
  pick,
  resolveT3Home,
} = require("../src/extras-settings");
const { createUsageReader, displayName, projectCache, readRegularFile } = require("../src/usage-limits");
const { createDispatch } = require("../src/cdp-dispatch");
const { EXTRAS_BINDING, WORLD_NAME, createExtrasService } = require("../src/extras");
const { buildExtrasPageSource } = require("../src/extras-page");
const { createRepoStatusService } = require("../src/repo-status");

// A secret-looking value placed in fields that must never leave the reader.
const FORBIDDEN = "forbidden-account-value-4b1d";

function tempDir(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-extras-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function layout(t) {
  const root = tempDir(t);
  const home = path.join(root, "t3home");
  const fix = path.join(root, "fix");
  fs.mkdirSync(path.join(home, "caches"), { recursive: true });
  fs.mkdirSync(path.join(home, "userdata"), { recursive: true });
  fs.mkdirSync(fix);
  return { root, home, fix };
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

const NOW = Date.parse("2026-11-19T15:00:00Z");

function cache(id, driver, overrides = {}) {
  return {
    instanceId: id,
    driver,
    displayName: "1",
    accentColor: "#e06d14",
    enabled: true,
    auth: { email: FORBIDDEN, token: FORBIDDEN },
    config: { apiKey: FORBIDDEN },
    usageLimits: {
      checkedAt: new Date(NOW - 2 * 60 * 1000).toISOString(),
      resetCredits: FORBIDDEN,
      windows: [
        { id: "w", kind: "weekly", label: "Weekly", usedPercent: 83.4, windowDurationMins: 10080, resetsAt: "2026-11-21T05:00:00Z", secret: FORBIDDEN },
      ],
    },
    ...overrides,
  };
}

// ---- Settings ---------------------------------------------------------------

test("T3 Code's home follows T3CODE_HOME like T3 Code does", () => {
  const home = path.resolve("/home/me");
  assert.equal(resolveT3Home({}, home), path.join(home, ".t3"));
  assert.equal(resolveT3Home({ T3CODE_HOME: "   " }, home), path.join(home, ".t3"));
  assert.equal(resolveT3Home({ T3CODE_HOME: " ~/other " }, home), path.join(home, "other"));
  assert.equal(resolveT3Home({ T3CODE_HOME: "relative" }, home), path.join(home, "relative"));
  assert.equal(resolveT3Home({ T3CODE_HOME: path.resolve("/abs/t3") }, home), path.resolve("/abs/t3"));
});

test("only the allowed settings and values are accepted", () => {
  assert.deepEqual(applyChange({}, { type: "set", key: "usageLimits", value: false }), { usageLimits: false });
  assert.deepEqual(applyChange({}, { type: "set", key: "rtlLayout", value: false }), { rtlLayout: false });
  assert.equal(applyChange({}, { type: "set", key: "rtlLayout", value: "off" }), null);
  assert.equal(applyChange({}, { type: "set", key: "usageLimits", value: "no" }), null);
  assert.equal(applyChange({}, { type: "set", key: "evil", value: true }), null);
  assert.equal(applyChange({}, { type: "set", key: "__proto__", value: true }), null);
  assert.equal(applyChange({}, { type: "hideAccount", id: "../x", hidden: true }), null);
  assert.deepEqual(applyChange({ keep: 1 }, { type: "hideAccount", id: "codex", hidden: true }), { keep: 1, usageHiddenAccounts: ["codex"] });
  assert.deepEqual(pick({ repoStatus: false, usageHiddenAccounts: ["a", "a", 5, "b/c"], other: FORBIDDEN }), {
    rtlLayout: true,
    repoStatus: false,
    usageLimits: true,
    usageHiddenAccounts: ["a"],
  });
});

test("quick changes from the same starting state all persist, and unknown keys stay on disk only", async (t) => {
  const { home, fix } = layout(t);
  writeJson(path.join(fix, "settings.json"), { repoStatus: false, custom: FORBIDDEN });
  const store = createSettingsStore({ directory: fix, t3Home: home });
  const results = await Promise.all([
    store.change({ type: "hideAccount", id: "codex", hidden: true }),
    store.change({ type: "hideAccount", id: "ai2", hidden: true }),
    store.change({ type: "set", key: "usageLimits", value: false }),
  ]);
  assert.ok(results.every((result) => result.ok));
  const disk = JSON.parse(fs.readFileSync(path.join(fix, "settings.json"), "utf8"));
  assert.deepEqual(disk.usageHiddenAccounts.sort(), ["ai2", "codex"]);
  assert.equal(disk.usageLimits, false);
  assert.equal(disk.repoStatus, false);
  assert.equal(disk.custom, FORBIDDEN);
  assert.ok(!JSON.stringify(store.get()).includes(FORBIDDEN));
  assert.ok(!JSON.stringify(results).includes(FORBIDDEN));
  assert.deepEqual(fs.readdirSync(fix).filter((name) => name.endsWith(".tmp")), []);
});

test("a settings file that cannot be parsed is never overwritten", async (t) => {
  const { home, fix } = layout(t);
  fs.writeFileSync(path.join(fix, "settings.json"), "{ not json", "utf8");
  const store = createSettingsStore({ directory: fix, t3Home: home });
  assert.equal(store.get().writable, false);
  const result = await store.change({ type: "set", key: "usageLimits", value: false });
  assert.equal(result.ok, false);
  assert.equal(result.error, "unreadable-file");
  assert.equal(fs.readFileSync(path.join(fix, "settings.json"), "utf8"), "{ not json");
  fs.writeFileSync(path.join(fix, "settings.json"), "[1]", "utf8");
  assert.equal((await store.change({ type: "set", key: "usageLimits", value: false })).error, "unreadable-file");
});

test("a byte order mark is accepted and a missing file means the defaults", async (t) => {
  const { home, fix } = layout(t);
  const store = createSettingsStore({ directory: fix, t3Home: home });
  assert.deepEqual(pick(store.get()), { rtlLayout: true, repoStatus: true, usageLimits: true, usageHiddenAccounts: [] });
  fs.writeFileSync(path.join(fix, "settings.json"), "\uFEFF{\"repoStatus\":false}", "utf8");
  assert.equal(createSettingsStore({ directory: fix, t3Home: home }).get().repoStatus, false);
});

test("a folder whose name starts with two dots is still inside T3 Code's data folder", async (t) => {
  const { home } = layout(t);
  const inside = path.join(home, process.platform === "win32" ? "..extras" : "..\\extras");
  fs.mkdirSync(inside);
  const store = createSettingsStore({ directory: inside, t3Home: home });
  assert.equal((await store.change({ type: "set", key: "usageLimits", value: false })).error, "inside-t3-home");
  assert.equal(fs.existsSync(path.join(inside, "settings.json")), false);
});

test("a change that would make the file too large to read is not saved", async (t) => {
  const { home, fix } = layout(t);
  writeJson(path.join(fix, "settings.json"), { note: "x".repeat(256 * 1024 - 20) });
  const store = createSettingsStore({ directory: fix, t3Home: home });
  const result = await store.change({ type: "set", key: "usageLimits", value: false });
  assert.equal(result.ok, false);
  assert.equal(result.error, "write-failed");
  assert.equal(createSettingsStore({ directory: fix, t3Home: home }).get().writable, true);
});

test("a settings file fixed by hand applies without a restart and tells the listeners", async (t) => {
  const { home, fix } = layout(t);
  fs.writeFileSync(path.join(fix, "settings.json"), "{ broken", "utf8");
  const store = createSettingsStore({ directory: fix, t3Home: home });
  const heard = [];
  store.onChange((settings) => heard.push(settings.repoStatus));
  assert.equal(store.get().writable, false);
  writeJson(path.join(fix, "settings.json"), { repoStatus: false });
  const settings = store.reload();
  assert.equal(settings.writable, true);
  assert.equal(settings.repoStatus, false);
  assert.deepEqual(heard, [false]);
  store.reload();
  assert.deepEqual(heard, [false], "an unchanged file tells nobody");
});

test("the settings are never written inside T3 Code's data folder", async (t) => {
  const { home } = layout(t);
  const inside = path.join(home, "userdata");
  const store = createSettingsStore({ directory: inside, t3Home: home });
  const result = await store.change({ type: "set", key: "usageLimits", value: false });
  assert.equal(result.error, "inside-t3-home");
  assert.equal(fs.existsSync(path.join(inside, "settings.json")), false);

  const missingHome = createSettingsStore({ directory: tempDir(t), t3Home: path.join(home, "nope") });
  assert.equal((await missingHome.change({ type: "set", key: "usageLimits", value: false })).error, "path-unverified");
});

test("T3 Code's settings file as a link to this file, even one not created yet, is refused", async (t) => {
  const { home, fix } = layout(t);
  const t3Settings = path.join(home, "userdata", "settings.json");
  try {
    fs.symlinkSync(path.join(fix, "settings.json"), t3Settings, "file");
  } catch {
    t.skip("links cannot be created here");
    return;
  }
  const store = createSettingsStore({ directory: fix, t3Home: home });
  // A link whose target cannot be resolved stops the write.
  assert.equal((await store.change({ type: "set", key: "usageLimits", value: false })).error, "path-unverified");
  assert.equal(fs.existsSync(path.join(fix, "settings.json")), false);
  // Once the target exists, the link is seen as this very file.
  writeJson(path.join(fix, "settings.json"), {});
  assert.equal((await store.change({ type: "set", key: "usageLimits", value: false })).error, "inside-t3-home");
  assert.equal(fs.readFileSync(path.join(fix, "settings.json"), "utf8"), "{}");
});

test("a link to T3 Code's data folder is refused", async (t) => {
  const { root, home } = layout(t);
  const link = path.join(root, "linked");
  try {
    fs.symlinkSync(path.join(home, "userdata"), link, "junction");
  } catch {
    t.skip("links cannot be created here");
    return;
  }
  const store = createSettingsStore({ directory: link, t3Home: home });
  assert.equal((await store.change({ type: "set", key: "usageLimits", value: false })).error, "inside-t3-home");
  assert.equal(fs.existsSync(path.join(home, "userdata", "settings.json")), false);
});

test("a failed write answers write-failed and leaves no temp file", async (t) => {
  const { home, fix } = layout(t);
  const failing = { ...fs, renameSync: () => { throw new Error("locked"); }, realpathSync: fs.realpathSync };
  const store = createSettingsStore({ directory: fix, t3Home: home, fileSystem: failing });
  const result = await store.change({ type: "set", key: "usageLimits", value: false });
  assert.equal(result.ok, false);
  assert.equal(result.error, "write-failed");
  assert.deepEqual(fs.readdirSync(fix), []);
  // The queue goes on after a failure.
  const ok = createSettingsStore({ directory: fix, t3Home: home });
  assert.equal((await ok.change({ type: "set", key: "usageLimits", value: false })).ok, true);
});

// ---- Usage reader -----------------------------------------------------------

test("only the allowed cache fields are kept", () => {
  const account = projectCache("claudeAgent", cache("claudeAgent", "claudeAgent"));
  assert.ok(!JSON.stringify(account).includes(FORBIDDEN));
  assert.deepEqual(account.windows, [{ label: "Weekly", usedPercent: 83, resetsAt: Date.parse("2026-11-21T05:00:00Z"), windowDurationMins: 10080 }]);
  assert.equal(projectCache("other", cache("claudeAgent", "claudeAgent")), null);
  assert.equal(projectCache("x", { instanceId: "x", driver: "bad driver" }), null);
});

test("percentages are clamped, and a malformed reset drops only its window", () => {
  const account = projectCache("x", cache("x", "codex", {
    usageLimits: {
      checkedAt: new Date(NOW).toISOString(),
      windows: [
        { label: "A", usedPercent: 140 },
        { label: "B", usedPercent: -3, resetsAt: "not a date" },
        { label: "C", usedPercent: "12" },
        { label: "", usedPercent: 5 },
      ],
    },
  }));
  assert.deepEqual(account.windows, [{ label: "A", usedPercent: 100, resetsAt: null, windowDurationMins: null }]);
});

test("names follow T3 Code's display names", () => {
  assert.equal(displayName({ id: "claude_ai2", driver: "claudeAgent", displayName: "2" }), "Claude 2");
  assert.equal(displayName({ id: "ai2", driver: "codex", displayName: "Codex Ai2" }), "Codex Ai2");
  assert.equal(displayName({ id: "x", driver: "codex", displayName: null }), "x");
});

test("the reader lists T3 Code's accounts and sends no other field", async (t) => {
  const { home } = layout(t);
  writeJson(path.join(home, "userdata", "settings.json"), {
    providerInstances: {
      claudeAgent: { driver: "claudeAgent", config: { apiKey: FORBIDDEN } },
      ai2: { driver: "codex" },
      reassigned: { driver: "codex" },
      nodata: { driver: "grok" },
    },
    other: FORBIDDEN,
  });
  writeJson(path.join(home, "caches", "claudeAgent.json"), cache("claudeAgent", "claudeAgent"));
  writeJson(path.join(home, "caches", "ai2.json"), cache("ai2", "codex", { displayName: "Codex Ai2" }));
  // A default instance has no entry and is listed while it has data.
  writeJson(path.join(home, "caches", "codex.json"), cache("codex", "codex", { displayName: "Codex Ai" }));
  // The id now belongs to another provider.
  writeJson(path.join(home, "caches", "reassigned.json"), cache("reassigned", "claudeAgent"));
  // Listed, but without data.
  writeJson(path.join(home, "caches", "nodata.json"), { instanceId: "nodata", driver: "grok" });
  // Removed from T3 Code and its data is old.
  writeJson(path.join(home, "caches", "removed.json"), cache("removed", "codex", {
    usageLimits: { checkedAt: new Date(NOW - 25 * 3600 * 1000).toISOString(), windows: [{ label: "W", usedPercent: 5 }] },
  }));
  writeJson(path.join(home, "caches", "mismatch.json"), cache("other-id", "codex"));
  fs.writeFileSync(path.join(home, "caches", "broken.json"), `{"secret":"${FORBIDDEN}"`, "utf8");
  const lines = [];
  const reader = createUsageReader({ t3Home: home, now: () => NOW, log: (line) => lines.push(line) });
  const { accounts, problem } = await reader.read();
  assert.equal(problem, null);
  // The re-assigned id is listed as a Codex account without data: its old
  // cache belongs to another provider.
  assert.deepEqual(accounts.map((account) => account.id), ["claudeAgent", "codex", "ai2", "reassigned", "nodata"]);
  const reassigned = accounts.find((account) => account.id === "reassigned");
  assert.deepEqual([reassigned.provider, reassigned.windows, reassigned.reportsUsage], ["Codex", [], true]);
  assert.equal(accounts.find((account) => account.id === "nodata").reportsUsage, false);
  assert.ok(accounts.every((account) => !("driver" in account)));
  assert.deepEqual(accounts.find((account) => account.id === "nodata").windows, []);
  assert.equal(accounts.find((account) => account.id === "claudeAgent").name, "Claude 1");
  assert.ok(!JSON.stringify(accounts).includes(FORBIDDEN));
  assert.ok(!lines.join("\n").includes(FORBIDDEN));
  assert.ok(lines.some((line) => line.includes("broken.json could not be parsed")));
});

test("windows past their reset are dropped on each read, without a file change", async (t) => {
  const { home } = layout(t);
  writeJson(path.join(home, "caches", "codex.json"), cache("codex", "codex", {
    usageLimits: {
      checkedAt: new Date(NOW).toISOString(),
      windows: [
        { label: "Session", usedPercent: 100, resetsAt: new Date(NOW + 60 * 1000).toISOString() },
        { label: "Weekly", usedPercent: 40, resetsAt: new Date(NOW + 3 * 86400 * 1000).toISOString() },
      ],
    },
  }));
  let time = NOW;
  const reader = createUsageReader({ t3Home: home, now: () => time });
  assert.deepEqual((await reader.read()).accounts[0].windows.map((window) => window.label), ["Session", "Weekly"]);
  time = NOW + 2 * 60 * 1000;
  assert.deepEqual((await reader.read()).accounts[0].windows.map((window) => window.label), ["Weekly"]);
  time = NOW + 4 * 86400 * 1000;
  assert.deepEqual((await reader.read()).accounts, []);
});

test("in T3 Code's WSL-only mode no account is shown", async (t) => {
  const { home } = layout(t);
  writeJson(path.join(home, "caches", "codex.json"), cache("codex", "codex"));
  writeJson(path.join(home, "userdata", "desktop-settings.json"), { wslOnly: true, wslBackendEnabled: true, token: FORBIDDEN });
  const result = await createUsageReader({ t3Home: home, now: () => NOW }).read();
  assert.deepEqual(result, { accounts: [], problem: "wsl-only" });
  writeJson(path.join(home, "userdata", "desktop-settings.json"), { wslOnly: true, wslBackendEnabled: false });
  assert.equal((await createUsageReader({ t3Home: home, now: () => NOW }).read()).accounts.length, 1);
  // T3 Code's older settings: wslMode "wsl" without wslBackendEnabled.
  writeJson(path.join(home, "userdata", "desktop-settings.json"), { wslOnly: true, wslMode: "wsl" });
  assert.equal((await createUsageReader({ t3Home: home, now: () => NOW }).read()).problem, "wsl-only");
  // A desktop settings file that cannot be read hides the chips.
  fs.writeFileSync(path.join(home, "userdata", "desktop-settings.json"), "{ broken", "utf8");
  assert.deepEqual(await createUsageReader({ t3Home: home, now: () => NOW }).read(), { accounts: [], problem: "desktop-settings-unreadable" });
});

test("a cache with an odd provider name does not break the list", async (t) => {
  const { home } = layout(t);
  writeJson(path.join(home, "caches", "odd.json"), cache("odd", "constructor"));
  writeJson(path.join(home, "caches", "codex.json"), cache("codex", "codex"));
  const { accounts } = await createUsageReader({ t3Home: home, now: () => NOW }).read();
  assert.deepEqual(accounts.map((account) => [account.id, account.provider]), [["codex", "Codex"], ["odd", "constructor"]]);
});

test("a change that cannot be serialized still answers", async (t) => {
  const { home, fix } = layout(t);
  let deep = "0";
  for (let i = 0; i < 20000; i += 1) deep = `[${deep}]`;
  fs.writeFileSync(path.join(fix, "settings.json"), `{"deep":${deep}}`, "utf8");
  const store = createSettingsStore({ directory: fix, t3Home: home });
  const result = await store.change({ type: "set", key: "usageLimits", value: false });
  assert.equal(result.ok, false);
  assert.ok(["write-failed", "unreadable-file"].includes(result.error));
});

test("the account list keeps providers that report usage, even with no open window", async () => {
  const cdp = fakeCdp();
  const accounts = [
    { id: "open", provider: "Codex", name: "Open", accent: null, reportsUsage: true, checkedAt: NOW, windows: [{ label: "W", usedPercent: 10, resetsAt: null }] },
    { id: "quiet", provider: "Codex", name: "Quiet", accent: null, reportsUsage: true, checkedAt: null, windows: [] },
    { id: "never", provider: "Cursor", name: "Never", accent: null, reportsUsage: false, checkedAt: null, windows: [] },
    { id: "hidden", provider: "Grok", name: "Hidden", accent: null, reportsUsage: false, checkedAt: null, windows: [] },
  ];
  const service = createExtrasService({
    send: cdp.send,
    store: fakeStore({ usageHiddenAccounts: ["hidden"] }),
    reader: { read: async () => ({ accounts, problem: null }) },
  });
  await service.attach("s");
  const done = service.handle("s", 10, JSON.stringify({ type: "check" }));
  await new Promise((resolve) => setImmediate(resolve));
  cdp.pending[0]({ result: { value: true } });
  await done;
  const push = cdp.sent.at(-1).params.expression;
  const data = JSON.parse(push.slice(push.indexOf("receive(") + 8, push.lastIndexOf(") === true")));
  // "hidden" never reports usage, so being hidden does not keep it listed.
  assert.deepEqual(data.accounts.map((account) => account.id), ["open", "quiet"]);
  assert.ok(!push.includes("reportsUsage"));
});

test("accounts in T3 Code's list reach the account list even without the cache folder", async (t) => {
  const { home } = layout(t);
  fs.rmSync(path.join(home, "caches"), { recursive: true });
  writeJson(path.join(home, "userdata", "settings.json"), { providerInstances: { ai2: { driver: "codex" }, cursor: { driver: "cursor" } } });
  const reader = createUsageReader({ t3Home: home, now: () => NOW });
  const cdp = fakeCdp();
  const service = createExtrasService({ send: cdp.send, store: fakeStore(), reader });
  await service.attach("s");
  const done = service.handle("s", 10, JSON.stringify({ type: "check" }));
  for (let i = 0; i < 20 && !cdp.pending.length; i += 1) await new Promise((resolve) => setImmediate(resolve));
  cdp.pending[0]({ result: { value: true } });
  await done;
  const push = cdp.sent.at(-1).params.expression;
  const data = JSON.parse(push.slice(push.indexOf("receive(") + 8, push.lastIndexOf(") === true")));
  // Codex reports usage; Cursor never does.
  assert.deepEqual(data.accounts.map((account) => account.id), ["ai2"]);
});

test("a settings file swapped for a link while it is read is refused", async (t) => {
  const { home, fix } = layout(t);
  const t3Settings = path.join(home, "userdata", "settings.json");
  writeJson(t3Settings, { secret: FORBIDDEN });
  const ours = path.join(fix, "settings.json");
  writeJson(ours, {});
  const store = createSettingsStore({ directory: fix, t3Home: home });
  const open = fs.openSync;
  let swapped = false;
  // The store opens the file under the folder's real path, which can differ
  // from the temp path in form, such as a short 8.3 name on a CI runner.
  const realFolder = fs.realpathSync.native(fix).toLowerCase();
  fs.openSync = (file, ...rest) => {
    const opened = path.resolve(String(file));
    const sameFile = path.basename(opened) === "settings.json" &&
      fs.realpathSync.native(path.dirname(opened)).toLowerCase() === realFolder;
    if (!swapped && sameFile) {
      swapped = true;
      fs.rmSync(ours);
      fs.linkSync(t3Settings, ours);
    }
    return open(file, ...rest);
  };
  let result;
  try {
    result = await store.change({ type: "set", key: "usageLimits", value: false });
  } finally {
    fs.openSync = open;
  }
  assert.ok(swapped);
  assert.equal(result.ok, false);
  assert.equal(result.error, "unreadable-file");
  assert.equal(fs.statSync(ours).nlink, 2, "the link was not replaced by a copy");
});

test("a settings file linked to another file is neither read nor saved over", async (t) => {
  const { home, fix } = layout(t);
  const t3Settings = path.join(home, "userdata", "settings.json");
  writeJson(t3Settings, { secret: FORBIDDEN });
  fs.linkSync(t3Settings, path.join(fix, "settings.json"));
  const store = createSettingsStore({ directory: fix, t3Home: home });
  assert.equal(store.get().writable, false);
  const result = await store.change({ type: "set", key: "usageLimits", value: false });
  assert.equal(result.ok, false);
  assert.equal(fs.statSync(path.join(fix, "settings.json")).nlink, 2, "the hard link stays a link");
  assert.equal(JSON.parse(fs.readFileSync(t3Settings, "utf8")).secret, FORBIDDEN);
  assert.ok(!JSON.stringify(result).includes(FORBIDDEN));
  fs.rmSync(path.join(fix, "settings.json"));
  const cacheFile = path.join(home, "caches", "codex.json");
  writeJson(cacheFile, { secret: FORBIDDEN });
  try {
    fs.symlinkSync(cacheFile, path.join(fix, "settings.json"), "file");
  } catch {
    return;
  }
  const linked = createSettingsStore({ directory: fix, t3Home: home });
  assert.equal((await linked.change({ type: "set", key: "usageLimits", value: false })).ok, false);
  assert.ok(fs.lstatSync(path.join(fix, "settings.json")).isSymbolicLink(), "the link was not replaced by a copy");
});

test("a hidden account that the reader no longer lists keeps a row", async () => {
  const cdp = fakeCdp();
  const service = createExtrasService({
    send: cdp.send,
    store: fakeStore({ usageHiddenAccounts: ["gone"] }),
    reader: { read: async () => ({ accounts: [], problem: null }) },
  });
  await service.attach("s");
  const done = service.handle("s", 10, JSON.stringify({ type: "check" }));
  await new Promise((resolve) => setImmediate(resolve));
  cdp.pending[0]({ result: { value: true } });
  await done;
  const push = cdp.sent.at(-1).params.expression;
  const data = JSON.parse(push.slice(push.indexOf("receive(") + 8, push.lastIndexOf(") === true")));
  assert.deepEqual(data.accounts.map((account) => [account.id, account.windows.length]), [["gone", 0]]);
});

test("T3 Code's provider list that cannot be read lists no accounts", async (t) => {
  const { home } = layout(t);
  fs.writeFileSync(path.join(home, "userdata", "settings.json"), "{ broken", "utf8");
  writeJson(path.join(home, "caches", "codex.json"), cache("codex", "codex"));
  const { accounts, problem } = await createUsageReader({ t3Home: home, now: () => NOW }).read();
  assert.deepEqual(accounts, []);
  assert.equal(problem, "provider-list-unreadable");
});

test("a link, a folder, or an oversized cache is not read", (t) => {
  const { root, home } = layout(t);
  const target = path.join(root, "target.json");
  writeJson(target, cache("codex", "codex"));
  const link = path.join(home, "caches", "codex.json");
  let linked = true;
  try {
    fs.symlinkSync(target, link, "file");
  } catch {
    linked = false;
  }
  if (linked) assert.equal(readRegularFile(link).reason, "not-a-file");
  fs.mkdirSync(path.join(home, "caches", "dir.json"));
  assert.equal(readRegularFile(path.join(home, "caches", "dir.json")).reason, "not-a-file");
  fs.writeFileSync(path.join(home, "caches", "big.json"), Buffer.alloc(2 * 1024 * 1024 + 10, 0x20));
  assert.equal(readRegularFile(path.join(home, "caches", "big.json")).reason, "too-large");
  fs.writeFileSync(path.join(home, "caches", "bom.json"), "\uFEFF{}", "utf8");
  assert.equal(readRegularFile(path.join(home, "caches", "bom.json")).text, "{}");
});

test("a file swapped between the two checks is refused", (t) => {
  const { home } = layout(t);
  const file = path.join(home, "caches", "codex.json");
  writeJson(file, cache("codex", "codex"));
  const swapped = { ...fs, fstatSync: (handle, options) => ({ ...fs.fstatSync(handle, options), isFile: () => true, ino: -1n }) };
  assert.equal(readRegularFile(file, swapped).reason, "not-a-file");
});

// ---- Dispatch ---------------------------------------------------------------

test("the dispatch routes each binding and gives page events to every service", async () => {
  const calls = [];
  const logs = [];
  const dispatch = createDispatch({
    bindings: { a: (id, params) => calls.push(["a", id, params.payload]) },
    navigated: [
      () => { throw new Error("first fails"); },
      (id, frame) => calls.push(["nav", id, frame.id]),
    ],
    documentReady: [async () => { throw new Error("async fails"); }, (id) => calls.push(["ready", id])],
    destroyed: [(id) => calls.push(["gone", id]), (id) => calls.push(["gone2", id])],
    log: (line) => logs.push(line),
  });
  assert.equal(dispatch.handle({ method: "Runtime.bindingCalled", sessionId: "s", params: { name: "a", payload: "p" } }), true);
  assert.equal(dispatch.handle({ method: "Runtime.bindingCalled", sessionId: "s", params: { name: "other" } }), false);
  assert.equal(dispatch.handle({ method: "Runtime.bindingCalled", sessionId: "s", params: { name: "toString" } }), false);
  assert.equal(dispatch.handle({ method: "Page.frameNavigated", sessionId: "s", params: { frame: { id: "f" } } }), true);
  assert.equal(dispatch.handle({ method: "Page.domContentEventFired", sessionId: "s", params: {} }), true);
  assert.equal(dispatch.handle({ id: 4, result: {} }), false);
  dispatch.targetDestroyed("s");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [["a", "s", "p"], ["nav", "s", "f"], ["ready", "s"], ["gone", "s"], ["gone2", "s"]]);
  assert.equal(logs.length, 2);
});

// ---- Extras service ---------------------------------------------------------

function fakeStore(initial = {}) {
  let settings = { repoStatus: true, usageLimits: true, usageHiddenAccounts: [], writable: true, problem: null, ...initial };
  return {
    get: () => settings,
    reload: () => settings,
    change: async (message) => {
      if (message.type === "set") settings = { ...settings, [message.key]: message.value };
      return { ok: true, error: null, settings };
    },
  };
}

function fakeCdp() {
  const sent = [];
  let nextContext = 10;
  const pending = [];
  const send = (method, params, sessionId) => {
    sent.push({ method, params, sessionId });
    if (method === "Page.getFrameTree") return Promise.resolve({ frameTree: { frame: { id: "main" } } });
    if (method === "Page.createIsolatedWorld") return Promise.resolve({ executionContextId: nextContext++ });
    if (method === "Runtime.evaluate" && params.expression.startsWith("(() => { const receive = window[")) {
      return new Promise((resolve) => pending.push(resolve));
    }
    return Promise.resolve({ result: { value: true } });
  };
  return { send, sent, pending };
}

const reader = { read: async () => ({ accounts: [{ id: "codex", provider: "Codex", name: "Codex Ai", accent: null, checkedAt: NOW, windows: [{ label: "W", usedPercent: 10, resetsAt: null }] }], problem: null }) };

test("the extras binding is exposed by world name and calls from other contexts are ignored", async () => {
  const cdp = fakeCdp();
  const store = fakeStore();
  const service = createExtrasService({ send: cdp.send, store, reader });
  await service.attach("s");
  const binding = cdp.sent.find((entry) => entry.method === "Runtime.addBinding");
  assert.deepEqual(binding.params, { name: EXTRAS_BINDING, executionContextName: WORLD_NAME });
  assert.ok(!("executionContextId" in binding.params));
  const source = cdp.sent.find((entry) => entry.method === "Runtime.evaluate" && entry.params.contextId === 10);
  assert.ok(source, "the page script runs in the isolated world");

  const before = cdp.sent.length;
  await service.handle("s", 999, JSON.stringify({ type: "set", key: "usageLimits", value: false }));
  await service.handle("s", 10, "x".repeat(2000));
  await service.handle("other", 10, JSON.stringify({ type: "check" }));
  assert.equal(cdp.sent.length, before);
  assert.equal(store.get().usageLimits, true);
});

test("a navigation starts a new world, and work of the earlier document is dropped", async () => {
  const cdp = fakeCdp();
  const service = createExtrasService({ send: cdp.send, store: fakeStore(), reader });
  await service.attach("s");
  const check = service.handle("s", 10, JSON.stringify({ type: "check" }));
  await service.navigated("s", { id: "main" });
  await check;
  // The state of the first document was never sent, and calls from its
  // context are now ignored.
  assert.equal(cdp.pending.length, 0);
  const before = cdp.sent.length;
  await service.handle("s", 10, JSON.stringify({ type: "check" }));
  assert.equal(cdp.sent.length, before);
  await service.navigated("s", { id: "child", parentId: "main" });
  assert.equal(cdp.sent.length, before, "a child frame starts nothing");
  const done = service.handle("s", 11, JSON.stringify({ type: "check" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cdp.pending.length, 1);
  cdp.pending[0]({ result: { value: true } });
  await done;
  const push = cdp.sent.at(-1);
  assert.equal(push.params.contextId, 11);
  assert.ok(push.params.expression.includes("\"kind\":\"state\""));
});

test("a settings change answers without waiting for other windows", async () => {
  const cdp = fakeCdp();
  const store = fakeStore();
  const service = createExtrasService({ send: cdp.send, store, reader });
  await service.attach("a");
  await service.attach("b");
  // Neither page ever answers its pushes.
  await service.handle("a", 10, JSON.stringify({ type: "set", key: "usageLimits", value: false }));
  assert.equal(store.get().usageLimits, false);
  const pushes = cdp.sent.filter((entry) => entry.method === "Runtime.evaluate" && entry.params.expression.includes("__t3Extras_"));
  assert.ok(pushes.some((entry) => entry.sessionId === "a" && entry.params.expression.includes("\"kind\":\"result\"")));
  assert.ok(pushes.some((entry) => entry.sessionId === "b" && entry.params.expression.includes("\"kind\":\"settings\"")));
});

test("each start gets its own receiver name", async () => {
  const cdp = fakeCdp();
  const service = createExtrasService({ send: cdp.send, store: fakeStore(), reader });
  await service.attach("s");
  await service.navigated("s", { id: "main" });
  const sources = cdp.sent.filter((entry) => entry.method === "Runtime.evaluate" && entry.params.expression.includes("pageMain"));
  const names = sources.map((entry) => /"receiver":"(__t3Extras_[0-9a-f]{24})"/.exec(entry.params.expression)?.[1]);
  assert.equal(names.length, 2);
  assert.ok(names[0] && names[1] && names[0] !== names[1]);
});

test("the page script parses and runs only in T3 Code's top frame", () => {
  const source = buildExtrasPageSource({ binding: "b", receiver: "r" });
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /window !== window\.top \|\| location\.protocol !== config\.protocol/);
  assert.match(source, /"protocol":"t3code:"/);
  assert.match(source, /isTrusted/);
});

// ---- Repository status on and off -------------------------------------------

test("turning repository status off drops a check that is still running and ignores opens", async () => {
  const sent = [];
  let releaseRemote;
  const opened = [];
  const service = createRepoStatusService({
    send: async (method, params, sessionId) => {
      sent.push({ method, params, sessionId });
      return { result: { value: true } };
    },
    findThreadFolder: async () => ({ folders: ["C:/repo"], projectId: "p" }),
    run: (command, args) => {
      if (command === "git" && args.includes("get-url")) {
        return new Promise((resolve) => {
          releaseRemote = () => resolve({ stdout: "https://github.com/o/r.git\n" });
        });
      }
      return Promise.resolve({ stdout: "[]" });
    },
    open: async (url) => opened.push(url),
  });
  const check = service.handle("s", JSON.stringify({ type: "check", path: "t3code://app/#/env/thread", reason: "navigate" }));
  await new Promise((resolve) => setImmediate(resolve));
  service.setEnabled(false);
  releaseRemote();
  await check;
  assert.equal(sent.filter((entry) => String(entry.params?.expression || "").includes("__t3RtlFixRepoStatusUpdate")).length, 0);
  await service.handle("s", JSON.stringify({ type: "open", repo: "o/r", kind: "issues" }));
  assert.deepEqual(opened, []);
});

test("a page is told whether repository status is on when it is attached and after a reload", async () => {
  const sent = [];
  const service = createRepoStatusService({
    send: async (method, params) => {
      sent.push({ method, params });
      return {};
    },
    enabled: false,
  });
  await service.attach("s");
  await service.reattach("s");
  const tells = sent.filter((entry) => String(entry.params?.expression || "").includes("const enable = window["));
  assert.equal(tells.length, 2);
  assert.ok(tells.every((entry) => entry.params.expression.includes("enable(false)")));
  service.setEnabled(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sent.at(-1).params.expression.includes("enable(true)"));
});

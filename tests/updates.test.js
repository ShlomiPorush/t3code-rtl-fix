"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createUpdateService, installCommand, isNewer, readInstalledVersion, readRelease } = require("../src/updates");

function tempDir(t, version) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-updates-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (version) record(directory, version);
  return directory;
}

const record = (directory, version) => fs.writeFileSync(path.join(directory, "version.txt"), `${version} random`);
const release = (version, body = "") => ({ tag_name: `v${version}`, body });

function setup(t, { installed = "1.8.0", latest = "1.9.0" } = {}) {
  const directory = tempDir(t, installed);
  const world = { latest: release(latest), now: 0, requests: 0, installs: [], finishes: true, logs: [], states: [] };
  const service = createUpdateService({
    directory,
    log: (message) => world.logs.push(message),
    now: () => world.now,
    fetchLatest: async () => {
      world.requests += 1;
      if (world.latest instanceof Error) throw world.latest;
      return world.latest;
    },
    runInstall: async (version) => {
      world.installs.push(version);
      if (world.finishes) record(directory, version);
    },
  });
  service.onChange((state) => world.states.push(state.status));
  return { directory, service, world };
}

test("versions compare by number", () => {
  assert.equal(isNewer("1.10.0", "1.9.9"), true);
  assert.equal(isNewer("1.9.0", "1.9.0"), false);
  assert.equal(isNewer("1.8.9", "1.9.0"), false);
  assert.equal(isNewer("1.0.0", null), true);
});

test("a release without an exact version is refused", () => {
  for (const tag of ["1.9.0", "v1.9", "v1.9.0-beta", "v1.9.0/../../other", "v1.9.0\n", "", null]) {
    assert.throws(() => readRelease({ tag_name: tag }), /no version/);
  }
});

test("the notes are the titles of the changes", () => {
  const body = [
    "## What's Changed",
    "* Show one thing by @someone in https://github.com/o/r/pull/1",
    "* Keep by @ signs in titles",
    "",
    "## New Contributors",
    "* @someone made their first contribution in https://github.com/o/r/pull/1",
    "**Full Changelog**: https://github.com/o/r/compare/a...b",
  ].join("\r\n");
  assert.deepEqual(readRelease(release("1.9.0", body)).notes, ["Show one thing", "Keep by @ signs in titles"]);
  const long = readRelease(release("1.9.0", Array(50).fill(`* ${"x".repeat(500)}`).join("\n"))).notes;
  assert.equal(long.length, 8);
  assert.equal(long[0].length, 160);
});

test("the installed version is the first word of version.txt", (t) => {
  const directory = tempDir(t);
  assert.equal(readInstalledVersion(directory), null);
  fs.writeFileSync(path.join(directory, "version.txt"), "0123456789abcdef0123456789abcdef");
  assert.equal(readInstalledVersion(directory), null, "an install from before versions");
  record(directory, "1.8.0");
  assert.equal(readInstalledVersion(directory), "1.8.0");
});

test("a check offers only a newer release", async (t) => {
  const { service, world } = setup(t);
  await service.check();
  assert.equal(service.get().status, "available");
  assert.equal(service.get().latest, "1.9.0");
  assert.deepEqual(world.states, ["checking", "available"]);
  world.latest = release("1.7.0");
  await service.check();
  assert.equal(service.get().status, "current");
});

test("a failed check says so and can be tried again", async (t) => {
  const { service, world } = setup(t);
  world.latest = new Error("offline");
  await service.check();
  assert.equal(service.get().status, "checkFailed");
  assert.match(world.logs.at(-1), /offline/);
  world.latest = release("1.8.0");
  await service.check();
  assert.equal(service.get().status, "current");
});

test("showing the version checks at most once an hour", async (t) => {
  const { service, world } = setup(t, { latest: "1.8.0" });
  await service.shown();
  await service.shown();
  assert.equal(world.requests, 1);
  world.now += 60 * 60 * 1000;
  await service.shown();
  assert.equal(world.requests, 2);
});

test("an offer that was withdrawn goes away when the version is shown again", async (t) => {
  const { service, world } = setup(t);
  await service.shown();
  assert.equal(service.get().status, "available");
  world.latest = release("1.8.0");
  world.now += 60 * 60 * 1000;
  await service.shown();
  assert.equal(service.get().status, "current");
});

test("an install takes the release that is the latest now", async (t) => {
  const { service, world } = setup(t);
  await service.check();
  world.latest = release("1.9.1");
  await service.install();
  assert.deepEqual(world.installs, ["1.9.1"]);
  assert.equal(service.get().status, "installed");
  assert.equal(service.get().installed, "1.9.1");
});

test("nothing is installed unless the latest release is newer", async (t) => {
  const { service, world } = setup(t);
  await service.install();
  assert.deepEqual(world.installs, [], "no check found a newer release yet");
  await service.check();
  world.latest = release("1.8.0");
  await service.install();
  assert.deepEqual(world.installs, [], "the release was withdrawn");
  assert.equal(service.get().status, "current");
});

test("an installer that did not finish is a failure that stays until a retry succeeds", async (t) => {
  const { directory, service, world } = setup(t);
  await service.check();
  world.finishes = false;
  await service.install();
  assert.equal(service.get().status, "installFailed");
  world.now += 24 * 60 * 60 * 1000;
  await service.shown();
  assert.equal(service.get().status, "installFailed");

  const reopened = createUpdateService({ directory, fetchLatest: async () => world.latest });
  await reopened.check();
  assert.equal(reopened.get().status, "available", "T3 Code opened again still offers the update");

  world.finishes = true;
  await service.install();
  assert.deepEqual(world.installs, ["1.9.0", "1.9.0"]);
  assert.equal(service.get().status, "installed");
});

test("a second click while a check or an install runs does nothing", async (t) => {
  const { service, world } = setup(t);
  await Promise.all([service.check(), service.check(), service.shown(), service.install()]);
  assert.equal(world.requests, 1);
  await Promise.all([service.install(), service.install(), service.check()]);
  assert.deepEqual(world.installs, ["1.9.0"]);
});

test("Windows runs the installed installer on the release package, without a shell", (t) => {
  const directory = tempDir(t);
  fs.writeFileSync(path.join(directory, "app-path.txt"), "\ufeffC:\\Programs\\t3code\\T3 Code (Beta).exe", "utf16le");
  const command = installCommand({
    directory,
    version: "1.9.0",
    platform: "win32",
    env: { SystemRoot: "C:\\Windows", ELECTRON_RUN_AS_NODE: "1", PSModulePath: "C:\\PowerShell\\7", Path: "C:\\Windows" },
  });
  assert.deepEqual(command, {
    file: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    args: [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", path.win32.join(directory, "install.ps1"),
      "-Source", "https://github.com/ShlomiPorush/t3code-rtl-fix/releases/download/v1.9.0/t3code-rtl-fix.zip",
      "-InstallDirectory", directory,
      "-T3CodePath", "C:\\Programs\\t3code\\T3 Code (Beta).exe",
    ],
    env: { SystemRoot: "C:\\Windows", Path: "C:\\Windows" },
  });
});

test("macOS runs the installed installer on the release package for the same app and Node.js", (t) => {
  const directory = tempDir(t);
  fs.writeFileSync(path.join(directory, "app-path.txt"), "/Applications/T3 Code (Beta).app/Contents/MacOS/T3 Code (Beta)");
  const run = (electron) => installCommand({
    directory,
    version: "1.9.0",
    platform: "darwin",
    electron,
    execPath: "/Users/a/.nvm/versions/node/v24/bin/node",
    env: { PATH: "/usr/bin:/bin", ELECTRON_RUN_AS_NODE: "1" },
  });
  const command = run(undefined);
  assert.equal(command.file, "/bin/bash");
  assert.deepEqual(command.args, [path.posix.join(directory, "install.sh"), "/Applications/T3 Code (Beta).app"]);
  assert.deepEqual(command.env, {
    PATH: "/Users/a/.nvm/versions/node/v24/bin:/usr/bin:/bin",
    T3_RTL_FIX_SOURCE: "https://github.com/ShlomiPorush/t3code-rtl-fix/releases/download/v1.9.0/t3code-rtl-fix.zip",
  });
  assert.equal(run("41.0.0").env.PATH, "/usr/bin:/bin");
});

test("a package address is built only from an exact version", (t) => {
  const directory = tempDir(t);
  fs.writeFileSync(path.join(directory, "app-path.txt"), "C:\\app.exe");
  assert.throws(() => installCommand({ directory, version: "1.9.0/../evil", platform: "win32", env: {} }), /not a version/);
});

test("both installers install every file of the fix and themselves", () => {
  const root = path.join(__dirname, "..");
  const windows = fs.readFileSync(path.join(root, "windows", "install.ps1"), "utf8");
  const mac = fs.readFileSync(path.join(root, "macos", "install.sh"), "utf8");
  for (const file of fs.readdirSync(path.join(root, "src"))) {
    assert.ok(windows.includes(`(Join-Path $sourceDirectory "${file}")`), `${file} on Windows`);
    assert.ok(mac.includes(`"$SRC/${file}"`), `${file} on macOS`);
  }
  assert.ok(windows.includes('(Join-Path $PSScriptRoot "install.ps1")'));
  assert.ok(mac.includes('"$SCRIPT_DIR/install.sh" "$INSTALL_DIR/"'));
});

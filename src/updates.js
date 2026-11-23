"use strict";

// The version of the fix, for the Extras section and the usage list: checks
// the latest GitHub release and installs it with the installer that the last
// install left beside this file. The page only asks to check or to install;
// every address is built here.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readSavedPath } = require("./t3-rtl-launcher");

const REPOSITORY = "ShlomiPorush/t3code-rtl-fix";
const LATEST_RELEASE = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const AUTOMATIC_CHECK_MS = 60 * 60 * 1000;
const MAX_NOTES = 8;
const MAX_NOTE_LENGTH = 160;

function isNewer(version, than) {
  if (!than) return true;
  const a = version.split(".").map(Number);
  const b = than.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// The titles in GitHub's generated notes, without their authors and links.
function readNotes(body) {
  return String(body ?? "")
    .split(/\r?\n/)
    .filter((line) => /^[*-] /.test(line) && !/ made their first contribution in /.test(line))
    .map((line) => line.slice(2).replace(/ by @\S+ in https:\S+$/, "").trim().slice(0, MAX_NOTE_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_NOTES);
}

function readRelease(release) {
  const tag = release?.tag_name;
  const version = typeof tag === "string" && tag.startsWith("v") ? tag.slice(1) : "";
  if (!VERSION.test(version)) throw new Error("the latest release has no version");
  return { version, notes: readNotes(release.body) };
}

async function fetchLatestRelease() {
  const response = await fetch(LATEST_RELEASE, {
    headers: { accept: "application/vnd.github+json", "user-agent": "t3code-rtl-fix" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  return response.json();
}

// The installer writes "<version> <random id>" as its last step, so an install
// that stopped midway leaves the earlier version here.
function readInstalledVersion(directory) {
  try {
    const version = fs.readFileSync(path.join(directory, "version.txt"), "utf8").trim().split(" ")[0];
    return VERSION.test(version) ? version : null;
  } catch {
    return null;
  }
}

function packageUrl(version) {
  if (!VERSION.test(version)) throw new Error("not a version");
  return `https://github.com/${REPOSITORY}/releases/download/v${version}/t3code-rtl-fix.zip`;
}

function installCommand({ directory, version, platform = process.platform, env = process.env, execPath = process.execPath, electron = process.versions.electron }) {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const executable = readSavedPath(path.join(directory, "app-path.txt"));
  if (platform === "win32") {
    // Windows PowerShell cannot load its own modules with the module path that
    // a T3 Code opened from PowerShell 7 hands down.
    for (const name of Object.keys(childEnv)) if (name.toLowerCase() === "psmodulepath") delete childEnv[name];
    return {
      file: path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", path.win32.join(directory, "install.ps1"),
        "-Source", packageUrl(version),
        "-InstallDirectory", directory,
        "-T3CodePath", executable,
      ],
      env: childEnv,
    };
  }
  childEnv.T3_RTL_FIX_SOURCE = packageUrl(version);
  // The installer keeps the Node.js it finds, and one from a version manager
  // is not on the PATH of an app opened from the Finder.
  if (!electron) childEnv.PATH = [path.posix.dirname(execPath), env.PATH].filter(Boolean).join(":");
  return {
    file: "/bin/bash",
    args: [path.posix.join(directory, "install.sh"), path.posix.resolve(executable, "../../..")],
    env: childEnv,
  };
}

// Runs this file as a detached process of its own, so an install that started
// finishes when T3 Code quits. Windows ends the launcher's other children with
// it, and PowerShell started detached exits at once without running anything.
function runInstaller({ directory, version }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, directory, version], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

function main([directory, version]) {
  const { file, args, env } = installCommand({ directory, version });
  const output = fs.openSync(path.join(directory, "launcher.log"), "a");
  const child = spawn(file, args, { env, windowsHide: true, stdio: ["ignore", output, output] });
  child.once("error", (error) => {
    fs.writeSync(output, `The installer could not start: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

function createUpdateService({
  directory,
  log = () => {},
  fetchLatest = fetchLatestRelease,
  runInstall = (version) => runInstaller({ directory, version }),
  now = Date.now,
}) {
  let state = { status: "idle", installed: readInstalledVersion(directory), latest: null, notes: [] };
  let checkedAt = null;
  let listener = () => {};

  function setState(next) {
    state = { ...state, ...next };
    listener(state);
  }

  const busy = () => state.status === "checking" || state.status === "installing";

  async function readLatest() {
    checkedAt = now();
    const release = readRelease(await fetchLatest());
    return { ...release, installed: readInstalledVersion(directory) };
  }

  async function check() {
    if (busy()) return;
    setState({ status: "checking" });
    try {
      const { version, notes, installed } = await readLatest();
      setState({ status: isNewer(version, installed) ? "available" : "current", installed, latest: version, notes });
    } catch (error) {
      log(`Could not check for an update of the fix: ${error.message}`);
      setState({ status: "checkFailed" });
    }
  }

  async function shown() {
    if (state.status === "installed" || state.status === "installFailed") return;
    if (checkedAt !== null && now() - checkedAt < AUTOMATIC_CHECK_MS) return;
    await check();
  }

  // Checks again, so a retry after a broken release takes the one that replaced it.
  async function install() {
    if (state.status !== "available" && state.status !== "installFailed") return;
    setState({ status: "installing" });
    try {
      const { version, installed } = await readLatest();
      if (!isNewer(version, installed)) {
        setState({ status: "current", installed });
        return;
      }
      log(`Installing version ${version} of the fix`);
      await runInstall(version);
      const recorded = readInstalledVersion(directory);
      if (recorded !== version) throw new Error("the installer did not finish");
      setState({ status: "installed", installed: recorded });
    } catch (error) {
      log(`The update of the fix was not installed: ${error.message}`);
      setState({ status: "installFailed" });
    }
  }

  return {
    get: () => state,
    check,
    shown,
    install,
    onChange(next) {
      listener = next;
    },
  };
}

module.exports = {
  createUpdateService,
  installCommand,
  isNewer,
  readInstalledVersion,
  readRelease,
  runInstaller,
};

if (require.main === module) main(process.argv.slice(2));

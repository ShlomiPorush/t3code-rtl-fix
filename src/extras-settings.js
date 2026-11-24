"use strict";

// The Extras settings: the add-on's own settings.json beside the launcher.
// The page changes one setting per message. Every change goes through one
// queue that reads the file again, applies the change, and replaces the file
// atomically, so two quick changes never overwrite each other.
//
// Unknown keys in the file stay in the file but never leave this module. A
// file that cannot be parsed is never overwritten.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { isChatWidth } = require("./chat-width");

const INSTANCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_FILE_BYTES = 256 * 1024;

const DEFAULTS = Object.freeze({
  rtlLayout: true,
  repoStatus: true,
  usageLimits: true,
  usageHiddenAccounts: Object.freeze([]),
  chatWidth: null,
  boringWorkingShelf: false,
  boringDoneShelf: false,
  boringPlainPinned: false,
});
const BOOLEAN_KEYS = new Set(["rtlLayout", "repoStatus", "usageLimits", "boringWorkingShelf", "boringDoneShelf", "boringPlainPinned"]);

// T3 Code reads its home from T3CODE_HOME, trimmed, with a leading ~ expanded
// and a relative path taken from the home folder. Empty means ~/.t3.
function resolveT3Home(env = process.env, homedir = os.homedir()) {
  const raw = typeof env.T3CODE_HOME === "string" ? env.T3CODE_HOME.trim() : "";
  if (!raw) return path.join(homedir, ".t3");
  if (raw === "~") return homedir;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(homedir, raw.slice(2));
  return path.resolve(homedir, raw);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  // A folder named like "..extras", or "..\extras" on macOS, where "\" is a
  // character of the name, is inside. Only a first part that is exactly ".."
  // leaves the parent.
  return relative.split(path.sep)[0] !== "..";
}

function sameFile(a, b) {
  return process.platform === "win32" || process.platform === "darwin"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

// The values the page may see, built only from the allowed keys.
function pick(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const hidden = Array.isArray(source.usageHiddenAccounts)
    ? [...new Set(source.usageHiddenAccounts.filter((id) => typeof id === "string" && INSTANCE_ID.test(id)))]
    : [];
  return {
    rtlLayout: typeof source.rtlLayout === "boolean" ? source.rtlLayout : DEFAULTS.rtlLayout,
    repoStatus: typeof source.repoStatus === "boolean" ? source.repoStatus : DEFAULTS.repoStatus,
    usageLimits: typeof source.usageLimits === "boolean" ? source.usageLimits : DEFAULTS.usageLimits,
    usageHiddenAccounts: hidden,
    chatWidth: isChatWidth(source.chatWidth) ? source.chatWidth : DEFAULTS.chatWidth,
    boringWorkingShelf:
      typeof source.boringWorkingShelf === "boolean" ? source.boringWorkingShelf : DEFAULTS.boringWorkingShelf,
    boringDoneShelf: typeof source.boringDoneShelf === "boolean" ? source.boringDoneShelf : DEFAULTS.boringDoneShelf,
    boringPlainPinned: typeof source.boringPlainPinned === "boolean" ? source.boringPlainPinned : DEFAULTS.boringPlainPinned,
  };
}

// Reads the file. The result says whether it may be written: a missing file
// may, a file that cannot be read or parsed may not.
function readFile(filePath) {
  const refused = { raw: {}, writable: false, problem: "unreadable-file" };
  let text;
  let handle = null;
  try {
    // Only a plain file of its own: a link, symbolic or hard, could point at
    // T3 Code's files, and a save would copy their contents here. The file is
    // checked by its path, then read through a handle that must be the same
    // file, so a link put in its place between the two is refused.
    const before = fs.lstatSync(filePath, { bigint: true });
    if (!before.isFile() || before.nlink > 1n || before.size > BigInt(MAX_FILE_BYTES)) return refused;
    handle = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const after = fs.fstatSync(handle, { bigint: true });
    if (!after.isFile() || after.nlink > 1n || after.dev !== before.dev || after.ino !== before.ino) return refused;
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fs.readSync(handle, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_FILE_BYTES) return refused;
    text = buffer.toString("utf8", 0, length);
  } catch (error) {
    if (error.code === "ENOENT") return { raw: {}, writable: true, problem: null };
    return refused;
  } finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {}
    }
  }
  try {
    const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { raw: {}, writable: false, problem: "unreadable-file" };
    }
    return { raw, writable: true, problem: null };
  } catch {
    return { raw: {}, writable: false, problem: "unreadable-file" };
  }
}

// Applies one page message to the raw file contents. Returns null for a
// message that is not allowed.
function applyChange(raw, message) {
  if (!message || typeof message !== "object") return null;
  const next = { ...raw };
  if (message.type === "set") {
    if (BOOLEAN_KEYS.has(message.key) && typeof message.value === "boolean") {
      next[message.key] = message.value;
      return next;
    }
    if (message.key === "chatWidth" && isChatWidth(message.value)) {
      next.chatWidth = message.value;
      return next;
    }
    return null;
  }
  if (message.type === "hideAccount") {
    if (typeof message.id !== "string" || !INSTANCE_ID.test(message.id) || typeof message.hidden !== "boolean") return null;
    const hidden = new Set(pick(raw).usageHiddenAccounts);
    if (message.hidden) hidden.add(message.id);
    else hidden.delete(message.id);
    next.usageHiddenAccounts = [...hidden];
    return next;
  }
  return null;
}

function createSettingsStore({
  directory,
  t3Home = resolveT3Home(),
  log = () => {},
  fileSystem = fs,
} = {}) {
  const filePath = path.join(directory, "settings.json");
  const listeners = new Set();
  let state = readFile(filePath);
  let queue = Promise.resolve();

  if (state.problem) log("Extras settings: settings.json could not be read; changes are off until it is fixed or deleted");

  // Resolves the real folders now, for each write, so a folder that moved or
  // became a link since the start is checked again.
  function verifiedFolder() {
    let folder;
    let home;
    try {
      folder = fileSystem.realpathSync.native(directory);
      home = fileSystem.realpathSync.native(t3Home);
    } catch {
      return { problem: "path-unverified" };
    }
    if (isInside(folder, home)) return { problem: "inside-t3-home" };
    const userdata = path.join(t3Home, "userdata");
    if (fileSystem.existsSync(userdata)) {
      try {
        if (sameFile(fileSystem.realpathSync.native(userdata), folder)) return { problem: "inside-t3-home" };
      } catch {
        return { problem: "path-unverified" };
      }
    }
    // T3 Code's settings file may be a link to this file, even one whose
    // target does not exist yet: the first write would create it. lstat sees
    // the link itself, and a link that cannot be resolved stops the write.
    const t3Settings = path.join(userdata, "settings.json");
    let t3Entry = null;
    try {
      t3Entry = fileSystem.lstatSync(t3Settings);
    } catch (error) {
      if (error.code !== "ENOENT") return { problem: "path-unverified" };
    }
    if (t3Entry) {
      let t3Real;
      try {
        t3Real = fileSystem.realpathSync.native(t3Settings);
      } catch {
        return { problem: "path-unverified" };
      }
      const ours = path.join(folder, "settings.json");
      let oursReal = ours;
      if (fileSystem.existsSync(ours)) {
        try {
          oursReal = fileSystem.realpathSync.native(ours);
        } catch {
          return { problem: "path-unverified" };
        }
      }
      if (sameFile(t3Real, oursReal)) return { problem: "inside-t3-home" };
    }
    return { folder };
  }

  function writeAtomically(folder, raw) {
    const target = path.join(folder, "settings.json");
    let text;
    try {
      // Deeply nested unknown keys can make this throw.
      text = `${JSON.stringify(raw, null, 2)}\n`;
    } catch {
      return false;
    }
    // A file the reader would refuse is not written.
    if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) return false;
    let mode = 0o644;
    try {
      mode = fileSystem.statSync(target).mode & 0o777;
    } catch {}
    const temp = path.join(folder, `.settings.${crypto.randomBytes(6).toString("hex")}.tmp`);
    let handle = null;
    try {
      handle = fileSystem.openSync(temp, "wx", mode);
      fileSystem.writeFileSync(handle, text, "utf8");
      fileSystem.fsyncSync(handle);
      fileSystem.closeSync(handle);
      handle = null;
      fileSystem.renameSync(temp, target);
      return true;
    } catch {
      if (handle !== null) {
        try {
          fileSystem.closeSync(handle);
        } catch {}
      }
      try {
        fileSystem.unlinkSync(temp);
      } catch {}
      return false;
    }
  }

  function notify(settings) {
    for (const listener of listeners) {
      try {
        listener(settings);
      } catch {}
    }
  }

  // Replaces the state, and tells the listeners when an allowed value changed.
  function setState(next) {
    const before = JSON.stringify(pick(state.raw));
    state = next;
    if (JSON.stringify(pick(state.raw)) !== before) notify(snapshot());
  }

  // Reads the file again, so a file fixed or changed by hand applies without
  // a restart.
  function reload() {
    setState(readFile(filePath));
    return snapshot();
  }

  function snapshot() {
    return { ...pick(state.raw), writable: state.writable, problem: state.problem };
  }

  // Resolves to { ok, settings, error }. The answer depends only on the disk.
  function change(message) {
    const run = () => {
      const verified = verifiedFolder();
      if (verified.problem) return { ok: false, error: verified.problem, settings: snapshot() };
      const current = readFile(path.join(verified.folder, "settings.json"));
      if (!current.writable) {
        setState(current);
        return { ok: false, error: current.problem, settings: snapshot() };
      }
      const next = applyChange(current.raw, message);
      if (!next) return { ok: false, error: "invalid", settings: snapshot() };
      if (!writeAtomically(verified.folder, next)) {
        setState(current);
        log("Extras settings: settings.json could not be written");
        return { ok: false, error: "write-failed", settings: snapshot() };
      }
      setState({ raw: next, writable: true, problem: null });
      return { ok: true, error: null, settings: snapshot() };
    };
    // Any failure answers, so the page never waits for an answer that does
    // not come.
    const safe = () => {
      try {
        return run();
      } catch {
        return { ok: false, error: "write-failed", settings: snapshot() };
      }
    };
    const result = queue.then(safe, safe);
    queue = result.catch(() => {});
    return result;
  }

  return {
    get: snapshot,
    reload,
    change,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = {
  INSTANCE_ID,
  applyChange,
  createSettingsStore,
  pick,
  resolveT3Home,
};

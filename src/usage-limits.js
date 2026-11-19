"use strict";

// Usage limits of T3 Code's local provider accounts, read from T3 Code's own
// provider caches, <T3 home>/caches/<instance id>.json. T3 Code writes them;
// this module only reads them.
//
// Each cache also holds account and setup data. Only these fields are kept:
// instanceId, driver, displayName, accentColor, and the usageLimits windows'
// label, usedPercent, and resetsAt, with usageLimits.checkedAt. Nothing else
// is logged, kept, or sent to the page.
//
// T3 Code's settings file gives only each instance's id and driver, to drop a
// cache whose id now belongs to another provider.

const fs = require("node:fs");
const path = require("node:path");
const { INSTANCE_ID } = require("./extras-settings");

const MAX_FILE_BYTES = 2 * 1024 * 1024;
// An account whose data is older than this has no usage data.
const MAX_DATA_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_TEXT = 200;
const DRIVER = /^[A-Za-z0-9_-]{1,64}$/;
const ACCENT = /^#[0-9a-fA-F]{6}$/;

// Providers whose T3 Code caches hold usage limits, so their accounts belong
// in the account list even before any cache exists.
const REPORTING_DRIVERS = ["claudeAgent", "codex", "antigravity"];

const PROVIDER_LABELS = {
  claudeAgent: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  cursor: "Cursor",
  opencode: "OpenCode",
  grok: "Grok",
  kiro: "Kiro",
  pi: "Pi",
};

// Reads one regular file of at most MAX_FILE_BYTES. A link, a junction, or a
// file swapped between the two checks is refused. Returns the text, or an
// object naming the reason.
function readRegularFile(filePath, fileSystem = fs) {
  let before;
  try {
    before = fileSystem.lstatSync(filePath, { bigint: true });
  } catch (error) {
    return { reason: error.code === "ENOENT" ? "missing" : "unreadable" };
  }
  if (!before.isFile()) return { reason: "not-a-file" };
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = fileSystem.openSync(filePath, flags);
  } catch {
    return { reason: "unreadable" };
  }
  try {
    const after = fileSystem.fstatSync(handle, { bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) return { reason: "not-a-file" };
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fileSystem.readSync(handle, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_FILE_BYTES) return { reason: "too-large" };
    const text = buffer.toString("utf8", 0, length);
    return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
  } catch {
    return { reason: "unreadable" };
  } finally {
    try {
      fileSystem.closeSync(handle);
    } catch {}
  }
}

function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const shortText = (value) =>
  typeof value === "string" && value.trim() && value.length <= MAX_TEXT ? value.trim() : null;

const parseTime = (value) => {
  if (typeof value !== "string" || value.length > 64) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

// The kept fields of one cache, or null when its identity does not match.
function projectCache(id, cache) {
  if (!cache || cache.instanceId !== id) return null;
  const driver = typeof cache.driver === "string" && DRIVER.test(cache.driver) ? cache.driver : null;
  if (!driver) return null;
  const usage = cache.usageLimits && typeof cache.usageLimits === "object" ? cache.usageLimits : null;
  const windows = [];
  if (usage && Array.isArray(usage.windows)) {
    for (const window of usage.windows.slice(0, 16)) {
      if (!window || typeof window !== "object") continue;
      const label = shortText(window.label);
      const percent = typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)
        ? Math.min(100, Math.max(0, window.usedPercent))
        : null;
      if (!label || percent === null) continue;
      // A missing reset is a window without a known reset. A reset that is
      // present but unreadable makes the window invalid.
      let resetsAt = null;
      if (window.resetsAt !== undefined && window.resetsAt !== null) {
        resetsAt = parseTime(window.resetsAt);
        if (resetsAt === null) continue;
      }
      // The window length gives T3 Code's pace. Up to a year.
      const minutes = window.windowDurationMins;
      const windowDurationMins = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 && minutes <= 366 * 24 * 60 ? minutes : null;
      windows.push({ label, usedPercent: Math.round(percent), resetsAt, windowDurationMins });
    }
  }
  return {
    id,
    driver,
    displayName: shortText(cache.displayName),
    accent: typeof cache.accentColor === "string" && ACCENT.test(cache.accentColor) ? cache.accentColor : null,
    // A provider that reports usage at all, even when no window is open now.
    // T3 Code marks a provider that cannot report usage, such as OpenCode, as
    // unavailable.
    reportsUsage: !!usage && !usage.unavailable && Array.isArray(usage.windows),
    checkedAt: usage ? parseTime(usage.checkedAt) : null,
    windows,
  };
}

// In T3 Code's WSL-only mode its server, and the provider caches it writes,
// live inside WSL, so the caches here are old. Only wslOnly, wslBackendEnabled,
// and the older wslMode are read from T3 Code's desktop settings, with T3
// Code's own rule. A file that exists but cannot be read leaves the mode
// unknown, and the chips stay hidden.
function wslMode(t3Home, fileSystem) {
  const result = readRegularFile(path.join(t3Home, "userdata", "desktop-settings.json"), fileSystem);
  if (result.reason === "missing") return "off";
  if (result.reason) return "unknown";
  const settings = parseObject(result.text);
  if (!settings) return "unknown";
  const backend = settings.wslBackendEnabled === true || (settings.wslBackendEnabled === undefined && settings.wslMode === "wsl");
  return settings.wslOnly === true && backend ? "on" : "off";
}

function providerLabel(driver) {
  return Object.hasOwn(PROVIDER_LABELS, driver) ? PROVIDER_LABELS[driver] : driver;
}

function displayName(account) {
  const provider = providerLabel(account.driver);
  const name = account.displayName;
  if (name && !/^\d+$/.test(name)) return name;
  if (name) return `${provider} ${name}`;
  return account.id;
}

// The provider list in T3 Code's settings: id -> driver. null when the file
// exists but cannot be read; an empty map when it is missing.
function readProviderDrivers(t3Home, fileSystem, logOnce) {
  const file = path.join(t3Home, "userdata", "settings.json");
  const result = readRegularFile(file, fileSystem);
  if (result.reason === "missing") return new Map();
  if (result.reason) {
    logOnce(`settings.json ${result.reason}`);
    return null;
  }
  const settings = parseObject(result.text);
  if (!settings) {
    logOnce("settings.json could not be parsed");
    return null;
  }
  const drivers = new Map();
  const instances = settings.providerInstances;
  if (instances && typeof instances === "object" && !Array.isArray(instances)) {
    for (const [id, entry] of Object.entries(instances)) {
      if (!INSTANCE_ID.test(id)) continue;
      const driver = entry && typeof entry === "object" && typeof entry.driver === "string" ? entry.driver : null;
      drivers.set(id, driver);
    }
  }
  return drivers;
}

function createUsageReader({ t3Home, fileSystem = fs, log = () => {}, now = Date.now } = {}) {
  const logged = new Set();
  const logOnce = (message) => {
    if (logged.has(message)) return;
    logged.add(message);
    log(`Usage limits: ${message}`);
  };
  let inFlight = null;

  function readNow() {
    const wsl = wslMode(t3Home, fileSystem);
    if (wsl === "on") return { accounts: [], problem: "wsl-only" };
    if (wsl === "unknown") {
      logOnce("desktop-settings.json could not be read");
      return { accounts: [], problem: "desktop-settings-unreadable" };
    }
    const drivers = readProviderDrivers(t3Home, fileSystem, logOnce);
    if (drivers === null) return { accounts: [], problem: "provider-list-unreadable" };
    // Without the cache folder, the accounts in T3 Code's list still show.
    let names = [];
    try {
      names = fileSystem.readdirSync(path.join(t3Home, "caches"));
    } catch {}
    const time = now();
    const accounts = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!INSTANCE_ID.test(id)) continue;
      const result = readRegularFile(path.join(t3Home, "caches", name), fileSystem);
      if (result.reason) {
        if (result.reason !== "missing") logOnce(`${name} ${result.reason}`);
        continue;
      }
      const cache = parseObject(result.text);
      if (!cache) {
        logOnce(`${name} could not be parsed`);
        continue;
      }
      const account = projectCache(id, cache);
      if (!account) continue;
      // An id that T3 Code now gives to another provider keeps an old cache.
      if (drivers.has(id) && drivers.get(id) !== account.driver) continue;
      const windows = account.windows.filter((window) => window.resetsAt === null || window.resetsAt > time);
      const fresh = account.checkedAt !== null && time - account.checkedAt <= MAX_DATA_AGE_MS && account.checkedAt <= time + 5 * 60 * 1000;
      const hasData = fresh && windows.length > 0;
      // A default or project-only instance has no entry in T3 Code's
      // settings, so it is listed while it has data. A removed instance
      // leaves once its data is old.
      if (!drivers.has(id) && !hasData) continue;
      accounts.push({
        id,
        driver: account.driver,
        provider: providerLabel(account.driver),
        name: displayName(account),
        accent: account.accent,
        reportsUsage: account.reportsUsage,
        checkedAt: hasData ? account.checkedAt : null,
        windows: hasData ? windows : [],
      });
    }
    // An account in T3 Code's list that has no cache yet, or no usage section,
    // reports usage when another account of its provider does.
    const reporting = new Set([
      ...REPORTING_DRIVERS,
      ...accounts.filter((account) => account.reportsUsage).map((account) => account.driver),
    ]);
    const listed = new Set(accounts.map((account) => account.id));
    for (const [id, driver] of drivers) {
      if (listed.has(id) || typeof driver !== "string" || !DRIVER.test(driver)) continue;
      accounts.push({ id, driver, provider: providerLabel(driver), name: id, accent: null, reportsUsage: reporting.has(driver), checkedAt: null, windows: [] });
    }
    for (const account of accounts) if (reporting.has(account.driver)) account.reportsUsage = true;
    // By provider, then by the name shown, with numbers in order: Claude 1
    // before Claude 2, Codex Ai before Codex Ai2.
    const compare = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
    accounts.sort((a, b) => compare(a.provider, b.provider) || compare(a.name, b.name) || compare(a.id, b.id));
    for (const account of accounts) delete account.driver;
    return { accounts, problem: null };
  }

  // Checks that arrive while one runs share its result.
  function read() {
    if (!inFlight) {
      inFlight = Promise.resolve()
        .then(readNow)
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  return { read };
}

module.exports = {
  createUsageReader,
  displayName,
  projectCache,
  readRegularFile,
};

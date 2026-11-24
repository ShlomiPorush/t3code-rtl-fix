"use strict";

// The GitHub side of the Home page: where the pull requests, releases, and
// security alerts of the asked repositories stand, read through the gh CLI,
// which keeps its own sign-in. The token never reaches the page.

const fs = require("node:fs");
const { runFile } = require("./repo-status");

// One query per repository: GitHub answers a large one slowly, and fails a
// query of several together with its neighbors.
const LANES = 4;
const PULLS = 30;
// Older facts are read again when Home opens.
const FRESH_MS = 15 * 60 * 1000;
// Older facts are read again while Home is closed.
const BACKGROUND_MS = 60 * 60 * 1000;
const CHECK_MS = 5 * 60 * 1000;
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;
const FORMAT = 1;

const REPOSITORY = /^[A-Za-z0-9_-]{1,39}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

const QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN) { totalCount }
    pullRequests(states: OPEN, first: ${PULLS}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes {
        number title isDraft updatedAt mergeable mergeStateStatus
        author { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
    latestRelease { tagName publishedAt tag { compare(headRef: "HEAD") { aheadBy } } }
    defaultBranchRef { target { ... on Commit { statusCheckRollup { state } } } }
  }
}`;

// Each read prints one word per alert. GitHub hides the secrets themselves.
const ALERTS = [
  { source: "Dependabot", path: "dependabot/alerts?state=open&per_page=100", words: ".[].security_advisory.severity" },
  { source: "code scanning", path: "code-scanning/alerts?state=open&per_page=100", words: '.[] | (.rule.security_severity_level // (if .rule.severity == "error" then "high" else "other" end))' },
  { source: "secret scanning", path: "secret-scanning/alerts?state=open&per_page=100&hide_secret=true", words: '.[] | "secret"' },
];

function readRequest(value) {
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string" && REPOSITORY.test(name))) return null;
  return [...new Set(value.map((name) => name.toLowerCase()))];
}

const isFailure = (state) => state === "FAILURE" || state === "ERROR";

function stageOf(pull, checks) {
  if (isFailure(checks)) return { stage: "open", tone: "bad", note: "check failed" };
  if (pull.mergeable === "CONFLICTING" || pull.mergeStateStatus === "DIRTY") {
    return { stage: "open", tone: "warn", note: "conflicts" };
  }
  if (pull.isDraft === true) return { stage: "open", tone: "", note: "draft" };
  if (checks === "PENDING" || checks === "EXPECTED") return { stage: "open", tone: "", note: "checks running" };
  // A repository without checks has ready pull requests too.
  if (pull.mergeStateStatus === "CLEAN") return { stage: "ready", tone: "ok", note: checks ? "" : "no checks" };
  const notes = { BLOCKED: "blocked by the branch rules", BEHIND: "behind the base branch" };
  return { stage: "open", tone: "", note: notes[pull.mergeStateStatus] || "merge state unknown" };
}

const isUpdate = (login) => /^(dependabot|renovate)(\[bot\])?$/i.test(login || "");

function readPull(node) {
  if (!Number.isInteger(node?.number)) return null;
  const checks = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  return {
    number: node.number,
    title: typeof node.title === "string" ? node.title.slice(0, 300) : "",
    at: Date.parse(node.updatedAt) || null,
    update: isUpdate(node.author?.login),
    ...stageOf(node, checks),
  };
}

// The release has three answers: one, none (null), and unknown (undefined).
function readRelease(release, failedField) {
  if (!release) return failedField ? undefined : null;
  const ahead = release.tag?.compare?.aheadBy;
  return {
    tag: String(release.tagName || "").slice(0, 100),
    at: Date.parse(release.publishedAt) || null,
    ahead: Number.isInteger(ahead) ? ahead : null,
  };
}

function readRepository(node, failedField) {
  const pulls = (node.pullRequests?.nodes || []).map(readPull).filter(Boolean);
  const openPulls = Number.isInteger(node.pullRequests?.totalCount) ? node.pullRequests.totalCount : null;
  return {
    pulls,
    openPulls,
    issues: Number.isInteger(node.issues?.totalCount) ? node.issues.totalCount : null,
    release: readRelease(node.latestRelease, failedField),
    mainFails: isFailure(node.defaultBranchRef?.target?.statusCheckRollup?.state),
    failedField,
    cut: pulls.length !== openPulls,
  };
}

// GitHub can answer with a repository and an error for one of its fields.
// Returns null when there is no repository in the answer.
function readAnswer(stdout) {
  let answer = null;
  try {
    answer = JSON.parse(stdout);
  } catch {
    return null;
  }
  const node = answer?.data?.repository;
  return node ? readRepository(node, Array.isArray(answer.errors) && answer.errors.length > 0) : null;
}

const isOff = ({ stderr }) => /HTTP 40[34]/.test(stderr) && !/rate limit/i.test(stderr);

// Counts the alerts of the sources that answer. Returns null when none does,
// and when a source failed for another reason than being off or not allowed.
function readAlerts(results) {
  if (results.some((result) => result.error && !isOff(result))) return null;
  const answered = ALERTS.map(({ source }, index) => ({ source, ...results[index] })).filter((result) => !result.error);
  if (answered.length === 0) return null;
  const words = answered.flatMap(({ stdout }) => stdout.split(/\s+/).filter(Boolean));
  const having = (word) => words.filter((item) => item === word).length;
  return { total: words.length, critical: having("critical"), high: having("high"), sources: answered.map(({ source }) => source) };
}

// The alerts in the counts of the thread details card, or null when they cover
// less than is known already.
function noteAlerts(before, { dependabot, codeScanning, secretScanning }) {
  const answered = [["Dependabot", dependabot], ["code scanning", codeScanning], ["secret scanning", secretScanning]].filter(([, found]) => found);
  const sources = answered.map(([source]) => source);
  if (sources.length === 0 || before?.sources.some((source) => !sources.includes(source))) return null;
  if (answered.some(([, found]) => found.capped || found.alerts.length < found.value)) return null;
  const alerts = answered.flatMap(([, found]) => found.alerts);
  const having = (severity) => alerts.filter((alert) => alert.severity === severity).length;
  return { total: alerts.length, critical: having("critical"), high: having("high"), sources };
}

// The pull requests in the counts of the thread details card, which do not say
// whether one can be merged.
function notePulls(before, { value, items }) {
  const pulls = items.map(({ number, title, author, time, draft }) => {
    const known = before.find((pull) => pull.number === number && !(draft && pull.stage === "ready"));
    const stage = known ? { stage: known.stage, tone: known.tone, note: known.note } : { stage: "open", tone: "", note: draft ? "draft" : "merge state unknown" };
    return { number, title, at: time, update: isUpdate(author), ...stage };
  });
  return { pulls, openPulls: value, cut: pulls.length !== value };
}

// One set of lanes reads for all windows. Facts are kept per repository, so a
// request is answered at once with what is known, and again as facts arrive.
function createHomeGithub({ run = runFile, log = () => {}, now = Date.now, file = null, isOn = () => true } = {}) {
  const known = new Map();
  const reading = new Set();
  const queue = new Set();
  const alertQueue = new Set();
  const windows = new Map();
  let lanes = 0;
  let ghMissing = false;
  let timer = null;

  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [name, entry] of saved.format === FORMAT ? Object.entries(saved.repositories) : []) {
      if (now() - entry.readAt < KEPT_MS) known.set(name, entry);
    }
  } catch {
    // The first start has no file, and a damaged one is written again.
  }

  function save() {
    if (!file) return;
    const repositories = Object.fromEntries([...known].filter(([, entry]) => entry.facts));
    try {
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ format: FORMAT, repositories }), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch (error) {
      log(`Home: the cache could not be saved: ${error.message}`);
    }
  }

  function tellWindows() {
    for (const { repositories, deliver } of windows.values()) deliver(snapshot(repositories));
  }

  function snapshot(repositories) {
    const facts = {};
    for (const name of repositories) {
      const entry = known.get(name);
      if (!entry) facts[name] = { status: "waiting" };
      else if (!entry.facts) facts[name] = { status: "unavailable" };
      else facts[name] = { status: "read", readAt: entry.readAt, stale: entry.failed, alerts: entry.alerts, ...entry.facts };
    }
    const failed = repositories.length > 0 && repositories.every((name) => known.get(name)?.failed);
    return { problem: !failed ? null : ghMissing ? "gh-missing" : "github-failed", repositories: facts };
  }

  async function readOne(name) {
    const [owner, repo] = name.split("/");
    reading.add(name);
    const triedAt = now();
    const result = await run("gh", [
      "api", "--hostname", "github.com", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `name=${repo}`,
    ]);
    reading.delete(name);
    const facts = readAnswer(result.stdout);
    ghMissing = result.error?.code === "ENOENT";
    const before = known.get(name);
    if (!facts && !before?.failed) {
      log(`Home: ${name} could not be read: ${(result.stderr || result.error?.message || "no answer").trim().split("\n")[0].slice(0, 200)}`);
    }
    known.set(name, facts
      ? { triedAt, readAt: triedAt, failed: false, facts, alerts: before?.alerts ?? null, alertsAt: before?.alertsAt ?? 0 }
      : { triedAt, readAt: before?.readAt ?? null, failed: true, facts: before?.facts ?? null, alerts: null });
    if (!facts) alertQueue.delete(name);
    else if (triedAt - known.get(name).alertsAt >= FRESH_MS) alertQueue.add(name);
  }

  // A newer read of the repository has an entry of its own, which keeps the
  // alerts of an older one out.
  async function readAlertsOf(name) {
    const entry = known.get(name);
    const results = [];
    for (const { path, words } of ALERTS) {
      results.push(await run("gh", ["api", "--hostname", "github.com", "--paginate", `repos/${name}/${path}`, "-q", words]));
    }
    entry.alerts = readAlerts(results);
    if (entry.alerts) entry.alertsAt = entry.triedAt;
  }

  // Alerts come last, so they do not hold up the pull requests.
  function nextJob() {
    for (const [names, job] of [[queue, readOne], [alertQueue, readAlertsOf]]) {
      for (const name of names) {
        names.delete(name);
        return () => job(name);
      }
    }
    return null;
  }

  async function lane() {
    lanes += 1;
    for (let job = nextJob(); job; job = nextJob()) {
      await job();
      tellWindows();
    }
    lanes -= 1;
    if (lanes === 0) save();
  }

  function readOlder(repositories, age) {
    for (const name of repositories) {
      const entry = known.get(name);
      if (!reading.has(name) && (!entry || now() - entry.triedAt >= age)) queue.add(name);
    }
    if (queue.size === 0) return;
    for (let free = LANES - lanes; free > 0; free -= 1) void lane();
  }

  function refresh() {
    if (!isOn()) return;
    for (const { repositories } of windows.values()) readOlder(repositories, BACKGROUND_MS);
  }

  // key names the window that asks. Its newest request replaces the one before.
  function read(key, repositories, deliver) {
    windows.set(key, { repositories, deliver });
    timer ||= setInterval(refresh, CHECK_MS).unref();
    deliver(snapshot(repositories));
    readOlder(repositories, FRESH_MS);
  }

  function forget(key) {
    windows.delete(key);
    if (windows.size > 0) return;
    clearInterval(timer);
    timer = null;
  }

  // The thread details card reads counts of the same repositories, so Home
  // gets them without a request of its own.
  function note(slug, counts) {
    const entry = known.get(slug.toLowerCase());
    if (!entry?.facts) return;
    const alerts = noteAlerts(entry.alerts, counts);
    entry.facts = {
      ...entry.facts,
      ...(counts.issues ? { issues: counts.issues.value } : {}),
      ...(counts.pulls ? notePulls(entry.facts.pulls, counts.pulls) : {}),
    };
    if (alerts) Object.assign(entry, { alerts, alertsAt: now() });
    tellWindows();
    save();
  }

  return { read, refresh, forget, note };
}

module.exports = { BACKGROUND_MS, FRESH_MS, LANES, createHomeGithub, readAlerts, readAnswer, readRequest, stageOf };

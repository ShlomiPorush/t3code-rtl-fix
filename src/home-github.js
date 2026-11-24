"use strict";

// The GitHub side of the Home page: where the pull requests, releases, and
// security alerts of the asked repositories stand, read through the gh CLI,
// which keeps its own sign-in. The token never reaches the page.

const { runFile } = require("./repo-status");

// One query per repository: GitHub answers a large one slowly, and fails a
// query of several together with its neighbors.
const LANES = 4;
const PULLS = 30;
const FRESH_MS = 5 * 60 * 1000;

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
  { source: "code scanning", path: "code-scanning/alerts?state=open&per_page=100", words: '.[] | (.rule.security_severity_level // "other")' },
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

function readPull(node) {
  if (!Number.isInteger(node?.number)) return null;
  const checks = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  return {
    number: node.number,
    title: typeof node.title === "string" ? node.title.slice(0, 300) : "",
    at: Date.parse(node.updatedAt) || null,
    update: /^(dependabot|renovate)(\[bot\])?$/i.test(node.author?.login || ""),
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

// One set of lanes reads for all windows. Facts are kept per repository, so a
// request is answered at once with what is known, and again as facts arrive.
function createHomeGithub({ run = runFile, log = () => {}, now = Date.now } = {}) {
  const known = new Map();
  const reading = new Set();
  const queue = new Set();
  const alertQueue = new Set();
  const waiting = new Map();
  let lanes = 0;
  let ghMissing = false;

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
      ? { triedAt, readAt: triedAt, failed: false, facts, alerts: before?.alerts ?? null }
      : { triedAt, readAt: before?.readAt ?? null, failed: true, facts: before?.facts ?? null, alerts: null });
    if (facts) alertQueue.add(name);
    else alertQueue.delete(name);
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
      for (const { repositories, deliver } of waiting.values()) deliver(snapshot(repositories));
    }
    lanes -= 1;
    if (lanes === 0) waiting.clear();
  }

  // key names the window that asks. Its newest request replaces the one before.
  function read(key, repositories, deliver) {
    deliver(snapshot(repositories));
    for (const name of repositories) {
      const entry = known.get(name);
      if (!reading.has(name) && (!entry || now() - entry.triedAt >= FRESH_MS)) queue.add(name);
    }
    if (lanes === 0 && queue.size === 0) return;
    waiting.set(key, { repositories, deliver });
    for (let free = LANES - lanes; free > 0; free -= 1) void lane();
  }

  return { read };
}

module.exports = { FRESH_MS, LANES, createHomeGithub, readAlerts, readAnswer, readRequest, stageOf };

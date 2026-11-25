"use strict";

// The GitHub side of the Home page: where the pull requests, releases, and
// security alerts of the asked repositories stand, read through the gh CLI,
// which keeps its own sign-in. The token never reaches the page.

const fs = require("node:fs");
const { issueDetail, pullDetail, readIssues, readSeverity, runFile, securityDetail } = require("./repo-status");

// One query per repository: GitHub answers a large one slowly, and fails a
// query of several together with its neighbors.
const LANES = 4;
const PULLS = 30;
const ISSUES = 30;
const LISTED_ALERTS = 100;
// Older facts are read again when Home opens.
const FRESH_MS = 15 * 60 * 1000;
// Older facts are read again while Home is closed.
const BACKGROUND_MS = 60 * 60 * 1000;
const CHECK_MS = 5 * 60 * 1000;
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;
const FORMAT = 2;

const REPOSITORY = /^[A-Za-z0-9_-]{1,39}\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

const QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: ${ISSUES}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes { number title updatedAt author { login } labels(first: 3) { nodes { name color } } }
    }
    pullRequests(states: OPEN, first: ${PULLS}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes {
        number title isDraft updatedAt mergeable mergeStateStatus reviewDecision
        author { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
    latestRelease { tagName publishedAt tag { compare(headRef: "HEAD") { aheadBy } } }
    defaultBranchRef { target { ... on Commit { statusCheckRollup { state } } } }
  }
}`;

const shortText = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
const alertNumber = (value) => (Number.isInteger(value) && value > 0 ? value : null);

const ALERTS = [
  {
    source: "Dependabot", key: "dependabot", path: "dependabot/alerts?state=open&per_page=100",
    fields: "{number, severity: .security_advisory.severity, package: (.security_vulnerability.package.name // .dependency.package.name)}",
    read: (alert) => ({ number: alertNumber(alert.number), severity: readSeverity(alert.severity), package: shortText(alert.package, 100) }),
  },
  {
    source: "code scanning", key: "codeScanning", path: "code-scanning/alerts?state=open&per_page=100",
    fields: "{number, severity: (.rule.security_severity_level // .rule.severity), rule: (.rule.description // .rule.name // .rule.id), path: .most_recent_instance.location.path}",
    read: (alert) => ({ number: alertNumber(alert.number), severity: readSeverity(alert.severity), rule: shortText(alert.rule, 200), path: shortText(alert.path, 200) }),
  },
  {
    source: "secret scanning", key: "secretScanning", path: "secret-scanning/alerts?state=open&per_page=100&hide_secret=true",
    fields: "{number, type: (.secret_type_display_name // .secret_type)}",
    read: (alert) => ({ number: alertNumber(alert.number), type: shortText(alert.type, 100) }),
  },
];
const alertQuery = ({ fields }) => `.[] | ${fields} | tojson`;

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

const REVIEWS = ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"];
const isUpdate = (login) => /^(dependabot|renovate)(\[bot\])?$/i.test(login || "");

function readPull(node) {
  if (!Number.isInteger(node?.number)) return null;
  const checks = node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
  return {
    number: node.number,
    title: typeof node.title === "string" ? node.title.slice(0, 300) : "",
    at: Date.parse(node.updatedAt) || null,
    author: shortText(node.author?.login, 100),
    draft: node.isDraft === true,
    review: REVIEWS.includes(node.reviewDecision) ? node.reviewDecision : null,
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
    issueItems: readIssues(node.issues)?.items ?? [],
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

function lineOf(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];
const rankOf = ({ severity }) => (SEVERITY_ORDER.includes(severity) ? SEVERITY_ORDER.indexOf(severity) : SEVERITY_ORDER.length);

function summarizeAlerts(parts) {
  const all = parts.flatMap(({ alerts }) => alerts);
  const having = (severity) => all.filter((alert) => alert.severity === severity).length;
  const lists = Object.fromEntries(parts.map(({ key, alerts }) => [key, { value: alerts.length, capped: false, alerts: [...alerts].sort((a, b) => rankOf(a) - rankOf(b)).slice(0, LISTED_ALERTS) }]));
  return { total: all.length, critical: having("critical"), high: having("high"), sources: parts.map(({ source }) => source), lists };
}

function readAlerts(results) {
  if (results.some((result) => result.error && !isOff(result))) return null;
  const answered = ALERTS.map((kind, index) => ({ ...kind, ...results[index] })).filter((result) => !result.error);
  if (answered.length === 0) return null;
  return summarizeAlerts(answered.map(({ source, key, read, stdout }) => ({
    source, key, alerts: stdout.split("\n").filter((line) => line.trim()).map((line) => read(lineOf(line))),
  })));
}

function noteAlerts(before, { dependabot, codeScanning, secretScanning }) {
  const found = { dependabot, codeScanning, secretScanning };
  const answered = ALERTS.filter(({ key }) => found[key]).map(({ source, key }) => ({ source, key, ...found[key] }));
  const sources = answered.map(({ source }) => source);
  if (sources.length === 0 || before?.sources.some((source) => !sources.includes(source))) return null;
  if (answered.some((part) => part.capped || part.alerts.length < part.value)) return null;
  return summarizeAlerts(answered);
}

function notePulls(before, { value, items }) {
  const pulls = items.map(({ number, title, author, time, draft, review }) => {
    const known = before.find((pull) => pull.number === number && !(draft && pull.stage === "ready"));
    const stage = known ? { stage: known.stage, tone: known.tone, note: known.note } : { stage: "open", tone: "", note: draft ? "draft" : "merge state unknown" };
    return { number, title, at: time, author, draft, review: review ?? null, update: isUpdate(author), ...stage };
  });
  return { pulls, openPulls: value, cut: pulls.length !== value };
}

const listed = (list) => (list && list.value > 0 ? list : null);

function detailsOf(facts, alerts) {
  const details = {};
  if (facts.issues > 0) details.issue = issueDetail({ value: facts.issues, capped: false, items: facts.issueItems || [] });
  if (facts.openPulls > 0) {
    const items = facts.pulls.map((pull) => ({ number: pull.number, title: pull.title, author: pull.author, time: pull.at, draft: pull.draft, review: pull.review }));
    details.pull = pullDetail({ value: facts.openPulls, capped: false, items });
  }
  if (alerts?.total > 0 && alerts.lists) {
    const { dependabot, codeScanning, secretScanning } = alerts.lists;
    details.shield = securityDetail({ value: alerts.total, capped: false }, {
      dependabot: listed(dependabot), codeScanning: listed(codeScanning), secretScanning: listed(secretScanning),
    });
  }
  return details;
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
      else facts[name] = factsOf(entry);
    }
    const failed = repositories.length > 0 && repositories.every((name) => known.get(name)?.failed);
    return { problem: !failed ? null : ghMissing ? "gh-missing" : "github-failed", repositories: facts };
  }

  function factsOf({ readAt, failed, alerts, facts }) {
    const { issueItems, ...shown } = facts;
    const summary = alerts && { total: alerts.total, critical: alerts.critical, high: alerts.high, sources: alerts.sources };
    return { status: "read", readAt, stale: failed, alerts: summary, ...shown, details: detailsOf(facts, alerts) };
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

  async function readAlertsOf(name) {
    const entry = known.get(name);
    const results = [];
    for (const kind of ALERTS) {
      results.push(await run("gh", ["api", "--hostname", "github.com", "--paginate", `repos/${name}/${kind.path}`, "-q", alertQuery(kind)]));
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
      ...(counts.issues ? { issues: counts.issues.value, issueItems: counts.issues.items ?? entry.facts.issueItems } : {}),
      ...(counts.pulls ? notePulls(entry.facts.pulls, counts.pulls) : {}),
    };
    if (alerts) Object.assign(entry, { alerts, alertsAt: now() });
    tellWindows();
    save();
  }

  return { read, refresh, forget, note };
}

module.exports = { BACKGROUND_MS, FRESH_MS, LANES, createHomeGithub, readAlerts, readAnswer, readRequest, stageOf };

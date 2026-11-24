"use strict";

// The GitHub side of the Home page: where the pull requests and releases of
// the asked repositories stand, read through the gh CLI, which keeps its own
// sign-in. The token never reaches the page.

const { runFile } = require("./repo-status");

// One query per repository: GitHub answers a large one slowly, and fails a
// query of several together with its neighbors.
const LANES = 4;
const PULLS = 20;
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

// Returns the repositories of a page's request, or null for anything else.
function readRequest(value) {
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string" && REPOSITORY.test(name))) return null;
  return [...new Set(value.map((name) => name.toLowerCase()))];
}

const isFailure = (state) => state === "FAILURE" || state === "ERROR";

// Where a pull request stands, in the order in which it is said.
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
function readRelease(release, partial) {
  if (!release) return partial ? undefined : null;
  const ahead = release.tag?.compare?.aheadBy;
  return {
    tag: String(release.tagName || "").slice(0, 100),
    at: Date.parse(release.publishedAt) || null,
    ahead: Number.isInteger(ahead) ? ahead : null,
  };
}

// partial: a field could not be read, or the pull requests are cut.
function readRepository(node, failedField) {
  const pulls = (node.pullRequests?.nodes || []).map(readPull).filter(Boolean);
  const total = node.pullRequests?.totalCount;
  return {
    pulls,
    issues: Number.isInteger(node.issues?.totalCount) ? node.issues.totalCount : null,
    release: readRelease(node.latestRelease, failedField),
    mainFails: isFailure(node.defaultBranchRef?.target?.statusCheckRollup?.state),
    partial: failedField || !Number.isInteger(total) || total > pulls.length,
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

// One set of lanes reads for all windows. Facts are kept per repository, so a
// request is answered at once with what is known, and again as facts arrive.
function createHomeGithub({ run = runFile, log = () => {}, now = Date.now } = {}) {
  const known = new Map();
  const reading = new Set();
  const queue = new Set();
  const waiting = new Map();
  let work = null;
  let ghMissing = false;

  function snapshot(repositories) {
    const facts = {};
    for (const name of repositories) {
      const entry = known.get(name);
      if (!entry) facts[name] = { status: "waiting" };
      else if (!entry.facts) facts[name] = { status: "unavailable" };
      else facts[name] = { status: "read", readAt: entry.readAt, stale: entry.failed, ...entry.facts };
    }
    const failed = repositories.length > 0 && repositories.every((name) => known.get(name)?.failed);
    return { problem: !failed ? null : ghMissing ? "gh-missing" : "github-failed", repositories: facts };
  }

  async function readOne(name) {
    const [owner, repo] = name.split("/");
    const result = await run("gh", [
      "api", "--hostname", "github.com", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `name=${repo}`,
    ]);
    const triedAt = now();
    const facts = readAnswer(result.stdout);
    ghMissing = result.error?.code === "ENOENT";
    const before = known.get(name);
    if (!facts && !before?.failed) {
      log(`Home: ${name} could not be read: ${(result.stderr || result.error?.message || "no answer").trim().split("\n")[0].slice(0, 200)}`);
    }
    known.set(name, facts
      ? { triedAt, readAt: triedAt, failed: false, facts }
      : { triedAt, readAt: before?.readAt ?? null, failed: true, facts: before?.facts ?? null });
  }

  async function lane() {
    for (const name of queue) {
      queue.delete(name);
      reading.add(name);
      await readOne(name);
      reading.delete(name);
      for (const { repositories, deliver } of waiting.values()) deliver(snapshot(repositories));
    }
  }

  // key names the window that asks. Its newest request replaces the one before.
  function read(key, repositories, deliver) {
    deliver(snapshot(repositories));
    for (const name of repositories) {
      const entry = known.get(name);
      if (!reading.has(name) && (!entry || now() - entry.triedAt >= FRESH_MS)) queue.add(name);
    }
    if (!work && queue.size === 0) return;
    waiting.set(key, { repositories, deliver });
    work ||= Promise.all(Array.from({ length: LANES }, lane)).finally(() => {
      work = null;
      waiting.clear();
    });
  }

  return { read };
}

module.exports = { FRESH_MS, LANES, createHomeGithub, readAnswer, readRequest, stageOf };

"use strict";

// Repository status in the thread details card: the open issues, open pull
// requests, and open security alerts of the GitHub repository behind the
// open thread. A row appears only when its count is above zero, and the whole
// section stays hidden when every count is zero or nothing can be read.
//
// The page reports which thread is open through a DevTools binding. The
// launcher finds the thread's folder in T3 Code's own database (read only),
// reads the folder's origin remote with git, and asks GitHub through the gh
// CLI, which keeps its own sign-in. The token never reaches the page.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const REPO_STATUS_BINDING = "__t3RtlFixRepoStatus";
const RECEIVER = "__t3RtlFixRepoStatusUpdate";
const PAGE_FLAG = "__t3RtlFixRepoStatusWatcher";
const CHECK = "__t3RtlFixRepoStatusCheck";
const SECTION_ATTRIBUTE = "data-t3-rtl-repo-status";
const STYLE_ID = "t3-rtl-fix-repo-status-style";
const TIP_CLASS = "t3-rtl-repo-status-tip";
// A pointer that rests on a row this long opens its tooltip.
const TIP_DELAY_MS = 250;

// A thread change or a return to the window reuses counts younger than this.
const FRESH_MS = 60 * 1000;
// The page asks for new counts this often while it is visible.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
// A thread's folder and a folder's remote change rarely.
const LOCATION_CACHE_MS = 5 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 20 * 1000;
// Code scanning and secret scanning counts come from one page of alerts.
const ALERT_PAGE_SIZE = 100;

// Thread ids include forms such as mcp:launch:<hash>. The id is only bound as
// a query parameter, so any character except whitespace and a path separator
// is accepted.
const SAFE_ID = /^[^\s/\\]{1,256}$/;
const GITHUB_REMOTE =
  /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;
// Each clickable row opens one GitHub page of the repository shown.
const PAGE_BY_KIND = {
  issues: "issues",
  pulls: "pulls",
  security: "security",
  "branches-remote": "branches",
  "branches-dead": "branches",
  "branches-stale": "branches",
};
// The branch query reads one page of branches.
const BRANCH_PAGE_SIZE = 100;
// A branch can carry several merged pull requests. Any of them may hold the
// branch's current tip.
const MERGED_PULLS_PER_BRANCH = 10;
const STALE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// The tooltip of a row lists this many issues, pull requests, or alerts.
const DETAIL_ITEMS = 5;
// The tooltip of a branch row lists this many branches.
const BRANCH_ITEMS = 8;
// Dependabot severities are counted from one page of alerts.
const DEPENDABOT_PAGE_SIZE = 100;
const LABEL_COLOR = /^[0-9a-f]{6}$/i;
const SEVERITIES = ["critical", "high", "medium", "low"];
const SEVERITY_LABELS = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
// GitHub names severities differently for each kind of alert.
const SEVERITY_ALIASES = { moderate: "medium", error: "high", warning: "medium", note: "low" };
const REVIEW_BADGES = {
  APPROVED: { text: "Approved", tone: "success" },
  CHANGES_REQUESTED: { text: "Changes requested", tone: "critical" },
  REVIEW_REQUIRED: { text: "Review required", tone: "muted" },
};

const COUNTS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: ${DETAIL_ITEMS}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes { number title updatedAt author { login } labels(first: 3) { nodes { name color } } }
    }
    pullRequests(states: OPEN, first: ${DETAIL_ITEMS}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes { number title updatedAt isDraft reviewDecision author { login } }
    }
    vulnerabilityAlerts(states: OPEN, first: ${DEPENDABOT_PAGE_SIZE}) {
      totalCount
      nodes { securityVulnerability { severity package { name } } }
    }
    defaultBranchRef { name }
    refs(refPrefix: "refs/heads/", first: ${BRANCH_PAGE_SIZE}) {
      totalCount
      nodes {
        name
        target { ... on Commit { oid committedDate } }
        associatedPullRequests(states: MERGED, first: ${MERGED_PULLS_PER_BRANCH}) {
          totalCount
          nodes { headRefOid }
        }
      }
    }
  }
}`;

// T3 Code routes a thread as /<environmentId>/<threadId>.
function parseThreadPath(pathname) {
  if (typeof pathname !== "string") return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  let environmentId;
  let threadId;
  try {
    environmentId = decodeURIComponent(segments[0]);
    threadId = decodeURIComponent(segments[1]);
  } catch {
    return null;
  }
  if (!SAFE_ID.test(environmentId) || !SAFE_ID.test(threadId)) return null;
  return { environmentId, threadId };
}

// Reads the route from the page address, in its path or in a hash route.
function parseThreadLocation(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const route = url.hash.startsWith("#/") ? url.hash.slice(1).split("?")[0] : url.pathname;
  return parseThreadPath(route);
}

function parseGitHubRemote(remoteUrl) {
  if (typeof remoteUrl !== "string") return null;
  const match = GITHUB_REMOTE.exec(remoteUrl.trim());
  if (!match) return null;
  const [, owner, name] = match;
  if (name === "." || name === "..") return null;
  return { owner, name, slug: `${owner}/${name}` };
}

function repositoryUrl(repo, kind) {
  const page = Object.hasOwn(PAGE_BY_KIND, kind) ? PAGE_BY_KIND[kind] : null;
  if (!repo || !page) return null;
  return `https://github.com/${repo.owner}/${repo.name}/${page}`;
}

// Newest first. A branch without a readable time goes last.
function byNewest(a, b) {
  const rank = (branch) => (Number.isFinite(branch.time) ? branch.time : -Infinity);
  return rank(b) - rank(a);
}

function branchTime(branch) {
  return Number.isFinite(branch.time) ? branch.time : null;
}

// Sorts the branches into the four counts of the Branches group. The default
// branch is never counted. A branch is dead when its pull request merged with
// its current tip, or when it is local and its branch on GitHub was deleted.
// A branch is stale when its newest commit, local or on GitHub, is older
// than STALE_DAYS and it is not dead.
function summarizeBranches({ defaultBranch, remote, local }, now) {
  const counted = (name) => name && name !== defaultBranch;
  const remoteNodes = remote ? remote.nodes.filter((node) => counted(node.name)) : [];
  const localBranches = local ? local.filter((branch) => counted(branch.name)) : [];
  const remoteNames = new Set(remote ? remote.nodes.map((node) => node.name) : []);
  // A partial list of GitHub branches cannot show that a branch is gone.
  const remoteComplete = remote && !remote.capped;
  // A branch whose state is unknown is neither dead nor stale, so the two
  // counts may be higher than shown. That happens with a partial GitHub list,
  // an unknown merge state, or no GitHub list for branches that track one.
  const capped =
    Boolean(remote?.capped) ||
    remoteNodes.some((node) => node.merged === null) ||
    (!remote && localBranches.some((branch) => branch.upstream && branch.upstream !== defaultBranch));

  const merged = remoteNodes.filter((node) => node.merged);
  const deleted = remoteComplete
    ? localBranches.filter((branch) => branch.upstream && !remoteNames.has(branch.upstream))
    : [];
  const mergedNames = new Set(merged.map((node) => node.name));
  const deletedNames = new Set(deleted.map((branch) => branch.name));
  const named = (branch) => ({ name: branch.name, time: branchTime(branch) });

  // A local branch and the GitHub branch it tracks are one branch, named as
  // on GitHub, whatever the local name. Other local branches stand alone,
  // even when a GitHub branch has the same name.
  const copies = new Map();
  // A copy marked skip is dead, or is a branch whose state is unknown.
  const addCopy = (key, name, time, skip) => {
    if (!Number.isFinite(time)) return;
    const copy = copies.get(key);
    if (copy) copy.time = Math.max(copy.time, time);
    else copies.set(key, { name, time, skip });
  };
  for (const node of remoteNodes) {
    addCopy(`remote:${node.name}`, node.name, node.time, node.merged !== false);
  }
  const unknownMerge = new Set(remoteNodes.filter((node) => node.merged === null).map((node) => node.name));
  for (const branch of localBranches) {
    // A local branch that tracks the default branch, such as a worktree
    // branch, is not the default branch and stands alone.
    const tracked = branch.upstream && branch.upstream !== defaultBranch ? branch.upstream : null;
    if (tracked && remoteNames.has(tracked)) {
      addCopy(`remote:${tracked}`, tracked, branch.time, mergedNames.has(tracked) || unknownMerge.has(tracked));
    } else if (tracked && !remoteComplete) {
      // Its GitHub branch is outside the partial list, so its age there is
      // unknown.
      continue;
    } else {
      addCopy(`local:${branch.name}`, branch.name, branch.time, deletedNames.has(branch.name));
    }
  }
  const staleBefore = now - STALE_DAYS * DAY_MS;
  const stale = [...copies.values()]
    .filter((copy) => copy.time < staleBefore && !copy.skip)
    .sort((a, b) => a.time - b.time)
    .map(({ name, time }) => ({ name, time, days: Math.floor((now - time) / DAY_MS) }));

  // The total counts every branch on GitHub, the default branch among them.
  const remoteTotal = remote ? Math.max(remote.total - (defaultBranch ? 1 : 0), 0) : 0;
  return {
    remote: remote
      ? {
          value: remoteTotal,
          capped: false,
          // The list holds one page of branches, so it can be shorter than
          // the count.
          partial: Boolean(remote.capped),
          branches: [...remoteNodes].sort(byNewest).map((node) => ({ ...named(node), merged: node.merged === true })),
        }
      : null,
    local: local
      ? {
          value: localBranches.length,
          capped: false,
          branches: [...localBranches].sort(byNewest).map((branch) => ({
            ...named(branch),
            upstream: branch.upstream,
            track: typeof branch.track === "string" ? branch.track : "",
            deleted: deletedNames.has(branch.name),
          })),
        }
      : null,
    // A merged branch is on GitHub and a deleted one is local, so they are
    // never the same branch.
    dead: {
      value: merged.length + deleted.length,
      capped,
      merged: [...merged].sort(byNewest).map(named),
      deleted: [...deleted].sort(byNewest).map(named),
    },
    stale: { value: stale.length, capped, branches: stale },
  };
}

function countValue(count) {
  return count && count.value > 0 ? count : null;
}

function countText(count) {
  return `${count.value}${count.capped ? "+" : ""}`;
}

// A tooltip section shows the first items of a list and how many more there
// are. total is the full count, which can be larger than the list read.
function listSection(list, total, limit, toItem, title) {
  const items = Array.isArray(list) ? list.slice(0, limit) : [];
  const section = { items: items.map(toItem), more: Math.max(total - items.length, 0) };
  if (title) section.title = title;
  return section;
}

function severityBadge(severity) {
  return severity ? { text: SEVERITY_LABELS[severity], tone: severity } : null;
}

// One chip per severity found, from the most severe.
function severityChips(alerts) {
  const counts = new Map();
  for (const alert of alerts) {
    if (alert.severity) counts.set(alert.severity, (counts.get(alert.severity) || 0) + 1);
  }
  return SEVERITIES.filter((severity) => counts.has(severity)).map((severity) => ({
    text: `${counts.get(severity)} ${SEVERITY_LABELS[severity]}`,
    tone: severity,
  }));
}

function bySeverity(a, b) {
  const rank = (alert) => (alert.severity ? SEVERITIES.indexOf(alert.severity) : SEVERITIES.length);
  return rank(a) - rank(b);
}

function compact(badges) {
  return badges.filter(Boolean);
}

function issueDetail(issues) {
  return {
    title: "Issues",
    summary: `${countText(issues)} open`,
    sections: [
      listSection(issues.items, issues.value, DETAIL_ITEMS, (issue) => ({
        lead: `#${issue.number}`,
        text: issue.title,
        meta: compact([issue.author]),
        time: issue.time,
        badges: (issue.labels || []).map((label) => ({ text: label.name, color: label.color })),
      })),
    ],
  };
}

function pullDetail(pulls) {
  return {
    title: "Pull requests",
    summary: `${countText(pulls)} open`,
    sections: [
      listSection(pulls.items, pulls.value, DETAIL_ITEMS, (pull) => ({
        lead: `#${pull.number}`,
        text: pull.title,
        meta: compact([pull.author]),
        time: pull.time,
        badges: compact([
          pull.draft ? { text: "Draft", tone: "muted" } : null,
          REVIEW_BADGES[pull.review] || null,
        ]),
      })),
    ],
  };
}

function securityDetail(total, { dependabot, codeScanning, secretScanning }) {
  const sections = [];
  const notes = [];
  if (dependabot) {
    const alerts = dependabot.alerts || [];
    sections.push({
      ...listSection([...alerts].sort(bySeverity), dependabot.value, DETAIL_ITEMS, (alert) => ({
        text: alert.package || "Unknown package",
        badges: compact([severityBadge(alert.severity)]),
      }), `Dependabot · ${countText(dependabot)}`),
      chips: alerts.length > 1 ? severityChips(alerts) : [],
    });
    if (alerts.length < dependabot.value) {
      notes.push(`Severities count the first ${alerts.length} Dependabot alerts.`);
    }
  }
  if (codeScanning) {
    const alerts = codeScanning.alerts || [];
    sections.push({
      ...listSection([...alerts].sort(bySeverity), codeScanning.value, DETAIL_ITEMS, (alert) => ({
        text: alert.rule || "Unnamed rule",
        meta: compact([alert.path]),
        badges: compact([severityBadge(alert.severity)]),
      }), `Code scanning · ${countText(codeScanning)}`),
      chips: alerts.length > 1 ? severityChips(alerts) : [],
    });
  }
  if (secretScanning) {
    sections.push(listSection(secretScanning.alerts, secretScanning.value, DETAIL_ITEMS, (alert) => ({
      text: alert.type || "Unknown secret type",
    }), `Secret scanning · ${countText(secretScanning)}`));
  }
  const detail = { title: "Security alerts", summary: `${countText(total)} open`, sections };
  if (notes.length) detail.note = notes.join(" ");
  return detail;
}

function localBadge(branch) {
  if (branch.deleted) return { text: "Deleted on GitHub", tone: "critical" };
  if (!branch.upstream) return { text: "No upstream", tone: "muted" };
  if (branch.track === "gone") return { text: "Upstream gone", tone: "critical" };
  if (!branch.track) return { text: "Up to date", tone: "success" };
  return { text: branch.track, tone: branch.track.includes("behind") ? "medium" : "info" };
}

const branchItem = (branch) => ({ text: branch.name, time: branch.time });
const UNKNOWN_NOTE = "Some branches could not be checked, so there may be more.";

function branchDetails(branches) {
  const details = {};
  const remote = countValue(branches.remote);
  if (remote) {
    details.remote = {
      title: "Remote branches",
      summary: `${countText(remote)} on GitHub`,
      sections: [
        listSection(remote.branches, remote.value, BRANCH_ITEMS, (branch) => ({
          ...branchItem(branch),
          badges: branch.merged ? [{ text: "Merged", tone: "success" }] : [],
        })),
      ],
    };
    if (remote.partial) details.remote.note = `Only the first ${BRANCH_PAGE_SIZE} branches on GitHub were read.`;
  }
  const local = countValue(branches.local);
  if (local) {
    details.local = {
      title: "Local branches",
      summary: `${countText(local)} in this folder`,
      sections: [
        listSection(local.branches, local.value, BRANCH_ITEMS, (branch) => ({
          ...branchItem(branch),
          badges: [localBadge(branch)],
        })),
      ],
      note: "Ahead and behind come from the last fetch.",
    };
  }
  const dead = countValue(branches.dead);
  if (dead) {
    details.dead = {
      title: "Dead branches",
      summary: `${countText(dead)} to clean up`,
      sections: [
        dead.merged.length
          ? listSection(dead.merged, dead.merged.length, BRANCH_ITEMS, branchItem, "Merged on GitHub")
          : null,
        dead.deleted.length
          ? listSection(dead.deleted, dead.deleted.length, BRANCH_ITEMS, branchItem, "Deleted on GitHub")
          : null,
      ].filter(Boolean),
    };
    if (dead.capped) details.dead.note = UNKNOWN_NOTE;
  }
  const stale = countValue(branches.stale);
  if (stale) {
    details.stale = {
      title: "Stale branches",
      summary: `No commits for ${STALE_DAYS}+ days`,
      sections: [listSection(stale.branches, stale.branches.length, BRANCH_ITEMS, branchItem)],
    };
    if (stale.capped) details.stale.note = UNKNOWN_NOTE;
  }
  return details;
}

// Turns the counts into the rows the page shows. Zero, missing, and
// unreadable counts produce no row. Each row carries the content of its
// tooltip.
function buildRows(status) {
  if (!status) return [];
  const rows = [];
  const issues = countValue(status.issues);
  if (issues) {
    rows.push({ kind: "issues", label: "Issues", count: countText(issues), detail: issueDetail(issues) });
  }
  const pulls = countValue(status.pulls);
  if (pulls) {
    rows.push({ kind: "pulls", label: "Pull requests", count: countText(pulls), detail: pullDetail(pulls) });
  }
  const security = {
    dependabot: countValue(status.dependabot),
    codeScanning: countValue(status.codeScanning),
    secretScanning: countValue(status.secretScanning),
  };
  const parts = Object.values(security).filter(Boolean);
  if (parts.length > 0) {
    const total = {
      value: parts.reduce((sum, count) => sum + count.value, 0),
      capped: parts.some((count) => count.capped),
    };
    rows.push({
      kind: "security",
      label: "Security alerts",
      count: countText(total),
      detail: securityDetail(total, security),
      tone: "warning",
    });
  }
  const branches = status.branches;
  if (branches) {
    const group = "branches";
    const details = branchDetails(branches);
    for (const [key, label] of [["remote", "Remote"], ["local", "Local"], ["dead", "Dead"], ["stale", "Stale"]]) {
      const count = countValue(branches[key]);
      if (count) {
        rows.push({ group, kind: `branches-${key}`, label, count: countText(count), detail: details[key] });
      }
    }
  }
  return rows;
}

function runFile(file, args, options = {}) {
  const env = { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  // On macOS the launcher starts without the login shell's PATH, so gh from
  // Homebrew would not be found.
  if (process.platform === "darwin") {
    env.PATH = [env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");
  }
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({ error, stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function totalCount(node) {
  return typeof node?.totalCount === "number" ? { value: node.totalCount, capped: false } : null;
}

const HEADS_PREFIX = "refs/heads/";

function text(value, max = 300) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function timeOf(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
}

function nodesOf(connection) {
  return Array.isArray(connection?.nodes) ? connection.nodes.filter(Boolean) : [];
}

function readSeverity(value) {
  const name = typeof value === "string" ? value.toLowerCase() : "";
  const severity = SEVERITY_ALIASES[name] || name;
  return SEVERITIES.includes(severity) ? severity : null;
}

// The open issues: their count and the most recently updated of them.
function readIssues(connection) {
  const count = totalCount(connection);
  if (!count) return null;
  count.items = nodesOf(connection)
    .filter((issue) => Number.isInteger(issue.number))
    .map((issue) => ({
      number: issue.number,
      title: text(issue.title),
      author: text(issue.author?.login, 100),
      time: timeOf(issue.updatedAt),
      labels: nodesOf(issue.labels).map((label) => ({
        name: text(label.name, 50),
        color: LABEL_COLOR.test(label.color ?? "") ? label.color.toLowerCase() : null,
      })),
    }));
  return count;
}

function readPulls(connection) {
  const count = totalCount(connection);
  if (!count) return null;
  count.items = nodesOf(connection)
    .filter((pull) => Number.isInteger(pull.number))
    .map((pull) => ({
      number: pull.number,
      title: text(pull.title),
      author: text(pull.author?.login, 100),
      time: timeOf(pull.updatedAt),
      draft: pull.isDraft === true,
      review: Object.hasOwn(REVIEW_BADGES, pull.reviewDecision ?? "") ? pull.reviewDecision : null,
    }));
  return count;
}

function readDependabot(connection) {
  const count = totalCount(connection);
  if (!count) return null;
  count.alerts = nodesOf(connection).map((alert) => ({
    severity: readSeverity(alert.securityVulnerability?.severity),
    package: text(alert.securityVulnerability?.package?.name, 100),
  }));
  return count;
}

// Only the fields the tooltip shows are kept. A secret scanning alert also
// holds the secret it found, which never leaves this function.
const ALERT_READERS = {
  "code-scanning": (alert) => ({
    severity: readSeverity(alert?.rule?.security_severity_level || alert?.rule?.severity),
    rule: text(alert?.rule?.description || alert?.rule?.name || alert?.rule?.id, 200),
    path: text(alert?.most_recent_instance?.location?.path, 200),
  }),
  "secret-scanning": (alert) => ({
    type: text(alert?.secret_type_display_name || alert?.secret_type, 100),
  }),
};

// Lists the local branches of a folder with the name of the branch they
// track on origin, as GitHub names it, the time of their newest commit, and
// how far they are from their upstream at the last fetch.
// Returns null when git cannot read it.
async function readLocalBranches(run, folder) {
  if (!folder) return null;
  const result = await run("git", [
    "-C",
    folder,
    "for-each-ref",
    "refs/heads",
    "--format=%(refname:lstrip=2)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(committerdate:unix)%00%(upstream:track,nobracket)",
  ]);
  if (result.error) return null;
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, remoteName = "", remoteRef = "", seconds = "", track = ""] = line.split("\0");
      const tracksOrigin = remoteName === "origin" && remoteRef.startsWith(HEADS_PREFIX);
      return {
        name,
        upstream: tracksOrigin ? remoteRef.slice(HEADS_PREFIX.length) : null,
        time: Number(seconds) * 1000,
        // Such as "ahead 1, behind 2" or "gone".
        track: track.trim().slice(0, 40),
      };
    });
}

function readRemoteBranches(refs) {
  if (!refs || !Array.isArray(refs.nodes)) return null;
  // GitHub returns null for a branch it could not resolve. The list is then
  // incomplete and cannot show that a branch is gone.
  const nodes = refs.nodes.filter((node) => node && typeof node.name === "string");
  return {
    total: refs.totalCount,
    capped: refs.totalCount > nodes.length,
    nodes: nodes.map((node) => ({
      name: node.name,
      time: Date.parse(node.target?.committedDate ?? ""),
      merged: readMerged(node),
    })),
  };
}

// A merged pull request counts only when it merged the branch's tip. A
// branch that gained commits after its merge is still in use. Returns null
// when the page of pull requests read is not the whole list and holds no
// match, so the answer is unknown.
function readMerged(node) {
  const pulls = node.associatedPullRequests;
  const oid = node.target?.oid;
  const list = Array.isArray(pulls?.nodes) ? pulls.nodes : [];
  if (oid && list.some((pull) => pull?.headRefOid === oid)) return true;
  // GitHub returns null for a pull request it could not resolve, so only a
  // whole page of readable pull requests proves that none holds the tip.
  const readable = list.every((pull) => typeof pull?.headRefOid === "string");
  const complete = readable && typeof pulls?.totalCount === "number" && pulls.totalCount <= list.length;
  return oid && complete ? false : null;
}

// gh exits with an error for a GraphQL answer that also carries errors, such
// as a missing permission for Dependabot alerts, so the answer is read anyway.
async function fetchCounts(run, repo, { folder, now = Date.now() } = {}) {
  // An explicit host keeps a GH_HOST setting for another server out of it.
  const graphql = run("gh", [
    "api",
    "--hostname",
    "github.com",
    "graphql",
    "-f",
    `query=${COUNTS_QUERY}`,
    "-f",
    `owner=${repo.owner}`,
    "-f",
    `name=${repo.name}`,
  ]);
  const alerts = (kind) =>
    run("gh", [
      "api",
      "--hostname",
      "github.com",
      `repos/${repo.owner}/${repo.name}/${kind}/alerts?state=open&per_page=${ALERT_PAGE_SIZE}`,
    ]).then((result) => {
      const list = parseJson(result.stdout);
      if (!Array.isArray(list)) return null;
      return {
        value: list.length,
        capped: list.length >= ALERT_PAGE_SIZE,
        alerts: list.map(ALERT_READERS[kind]),
      };
    });
  const [graphqlResult, codeScanning, secretScanning, local] = await Promise.all([
    graphql,
    alerts("code-scanning"),
    alerts("secret-scanning"),
    readLocalBranches(run, folder),
  ]);
  if (graphqlResult.error?.code === "ENOENT") {
    throw new Error("the gh command was not found");
  }
  const repository = parseJson(graphqlResult.stdout)?.data?.repository;
  if (!repository) {
    const reason = (graphqlResult.stderr || graphqlResult.error?.message || "no answer").trim();
    throw new Error(`GitHub did not return ${repo.slug}: ${reason.split("\n")[0]}`);
  }
  return {
    issues: readIssues(repository.issues),
    pulls: readPulls(repository.pullRequests),
    dependabot: readDependabot(repository.vulnerabilityAlerts),
    codeScanning,
    secretScanning,
    branches: readBranches(repository, local, now),
  };
}

// A branch answer that cannot be read leaves out the Branches group only, so
// the other rows still show.
function readBranches(repository, local, now) {
  try {
    return summarizeBranches(
      {
        defaultBranch: repository.defaultBranchRef?.name ?? null,
        remote: readRemoteBranches(repository.refs),
        local,
      },
      now,
    );
  } catch {
    return null;
  }
}

function defaultDatabaseDirectory() {
  return path.join(os.homedir(), ".t3", "userdata");
}

// T3 Code moved its threads to statev2.sqlite and stopped writing
// state.sqlite. The older file is read only when the newer one is missing.
const THREAD_DATABASES = [
  {
    file: "statev2.sqlite",
    query: `SELECT json_extract(t.payload_json, '$.worktreePath') AS worktree,
                   p.workspace_root AS root
            FROM orchestration_v2_projection_threads t
            LEFT JOIN projection_projects p ON p.project_id = t.project_id
            WHERE t.thread_id = ?`,
  },
  {
    file: "state.sqlite",
    query: `SELECT t.worktree_path AS worktree, p.workspace_root AS root
            FROM projection_threads t
            JOIN projection_projects p ON p.project_id = t.project_id
            WHERE t.thread_id = ?`,
  },
];

// node:sqlite ignores readOnly and opens the database for writing before
// Node.js 22.12 and in 23.0 and 23.1.
function opensSqliteReadOnly(version) {
  const [major, minor] = String(version).split(".").map(Number);
  if (major === 22) return minor >= 12;
  if (major === 23) return minor >= 2;
  return major > 23;
}

// Opens T3 Code's database read only for one lookup, so the launcher never
// holds it open while T3 Code migrates or checkpoints it.
function lookupThreadFolder(databaseDirectory, threadId) {
  const source = THREAD_DATABASES.map((candidate) => ({
    ...candidate,
    path: path.join(databaseDirectory, candidate.file),
  })).find((candidate) => fs.existsSync(candidate.path));
  if (!source) {
    throw new Error(`T3 Code's database was not found in ${databaseDirectory}`);
  }
  if (!opensSqliteReadOnly(process.versions.node)) {
    throw new Error(`Node.js ${process.versions.node} cannot open T3 Code's database read only`);
  }
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(source.path, { readOnly: true });
  try {
    const row = database.prepare(source.query).get(threadId);
    if (!row) return null;
    // A worktree that was removed after its branch merged can leave its
    // folder behind, so the project folder is the fallback.
    const folders = [...new Set([row.worktree, row.root].filter(Boolean))];
    return folders.length > 0 ? folders : null;
  } finally {
    database.close();
  }
}

function openExternal(run, url) {
  if (process.platform === "win32") {
    // explorer.exe hands a URL to the default browser and exits with code 1.
    return run(path.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe"), [url]);
  }
  return run(process.platform === "darwin" ? "open" : "xdg-open", [url]);
}

function createRepoStatusService({
  send,
  log = () => {},
  run = runFile,
  now = Date.now,
  databaseDirectory = defaultDatabaseDirectory(),
  findThreadFolder = (threadId) => lookupThreadFolder(databaseDirectory, threadId),
  open = (url) => openExternal(run, url),
} = {}) {
  const sessions = new Map();
  const attached = new Set();
  const folders = new Map();
  const remotes = new Map();
  const counts = new Map();
  const loggedMessages = new Set();

  function logOnce(message) {
    if (loggedMessages.has(message)) return;
    loggedMessages.add(message);
    log(`Repository status: ${message}`);
  }

  // An empty value is cached only when keepEmpty is set, so a thread that
  // T3 Code has not written yet is looked up again on the next check. A
  // failure drops the entry, so no later check shows a value from before it.
  function cached(cache, key, maxAge, load, keepEmpty = true) {
    const entry = cache.get(key);
    if (entry?.promise) return entry.promise;
    if (entry && now() - entry.at < maxAge) return Promise.resolve(entry.value);
    const promise = Promise.resolve()
      .then(load)
      .then(
        (value) => {
          if (value == null && !keepEmpty) cache.delete(key);
          else cache.set(key, { value, at: now() });
          return value;
        },
        (error) => {
          cache.delete(key);
          throw error;
        },
      );
    cache.set(key, { promise });
    return promise;
  }

  async function resolveRepository(threadId) {
    const found = await cached(
      folders,
      threadId,
      LOCATION_CACHE_MS,
      () => findThreadFolder(threadId),
      false,
    );
    for (const folder of [].concat(found || [])) {
      const repo = await cached(remotes, folder, LOCATION_CACHE_MS, async () => {
        const result = await run("git", ["-C", folder, "remote", "get-url", "origin"]);
        if (result.error?.code === "ENOENT") throw new Error("the git command was not found");
        return parseGitHubRemote(result.stdout);
      });
      // The folder also lists the local branches.
      if (repo) return { ...repo, folder };
    }
    return null;
  }

  async function push(sessionId, data) {
    const expression = `(() => { const receive = window[${JSON.stringify(RECEIVER)}]; if (typeof receive === "function") receive(${JSON.stringify(data)}); })()`;
    await send("Runtime.evaluate", { expression }, sessionId);
  }

  function loadCounts(repo, reason) {
    const maxAge = reason === "interval" ? REFRESH_INTERVAL_MS - 30 * 1000 : FRESH_MS;
    // Local branches belong to a folder, so two clones of one repository on
    // GitHub keep separate entries.
    return cached(counts, JSON.stringify([repo.slug, repo.folder]), maxAge, () =>
      fetchCounts(run, repo, { folder: repo.folder, now: now() }),
    );
  }

  async function check(sessionId, pagePath, reason) {
    const thread = parseThreadLocation(pagePath);
    const session = sessions.get(sessionId) || {};
    sessions.set(sessionId, session);
    session.path = pagePath;
    // The rows shown stay clickable while the same thread refreshes.
    const threadId = thread?.threadId ?? null;
    if (session.threadId !== threadId) {
      session.threadId = threadId;
      session.repo = null;
    }
    // A newer check may replace this one at any await.
    const current = () => session.path === pagePath;
    let rows = [];
    let repo = null;
    if (thread) {
      try {
        repo = await resolveRepository(thread.threadId);
        if (!current()) return;
        if (repo) rows = buildRows(await loadCounts(repo, reason));
      } catch (error) {
        logOnce(error.message);
        rows = [];
      }
    }
    if (!current()) return;
    session.repo = rows.length > 0 ? repo : null;
    await push(sessionId, { path: pagePath, repo: session.repo?.slug || null, rows });
  }

  async function handle(sessionId, payload) {
    const message = parseJson(payload);
    if (!message || typeof message !== "object") return;
    if (message.type === "check" && typeof message.path === "string") {
      await check(sessionId, message.path.slice(0, 2048), String(message.reason || ""));
      return;
    }
    if (message.type === "open") {
      const url = repositoryUrl(sessions.get(sessionId)?.repo, message.kind);
      if (url) await open(url);
    }
  }

  async function attach(sessionId) {
    const source = buildRepoStatusPageSource();
    // Without the Page domain, a reloaded page does not run the script
    // registered for new documents.
    await send("Page.enable", {}, sessionId);
    await send("Runtime.addBinding", { name: REPO_STATUS_BINDING }, sessionId);
    await send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
    await send("Runtime.evaluate", { expression: source }, sessionId);
    attached.add(sessionId);
  }

  // A reloaded page loses the binding. The launcher adds it again when the
  // new document is ready, and the page then checks again. The Runtime domain
  // would keep it, but would also hold T3 Code's console objects.
  async function reattach(sessionId) {
    if (!attached.has(sessionId)) return;
    await send("Runtime.addBinding", { name: REPO_STATUS_BINDING }, sessionId);
    await send(
      "Runtime.evaluate",
      { expression: `(() => { const check = window[${JSON.stringify(CHECK)}]; if (typeof check === "function") check("navigate"); })()` },
      sessionId,
    );
  }

  function forget(sessionId) {
    sessions.delete(sessionId);
    attached.delete(sessionId);
  }

  return { attach, reattach, handle, forget };
}

const ICONS = {
  repo: [["path", { d: "M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" }]],
  issues: [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["circle", { cx: "12", cy: "12", r: "1" }],
  ],
  pulls: [
    ["circle", { cx: "18", cy: "18", r: "3" }],
    ["circle", { cx: "6", cy: "6", r: "3" }],
    ["path", { d: "M13 6h3a2 2 0 0 1 2 2v7" }],
    ["path", { d: "M6 9v12" }],
  ],
  security: [
    ["path", { d: "M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" }],
    ["path", { d: "M12 8v4" }],
    ["path", { d: "M12 16h.01" }],
  ],
  "branches-remote": [["path", { d: "M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" }]],
  "branches-local": [
    ["path", { d: "M6 3v12" }],
    ["circle", { cx: "18", cy: "6", r: "3" }],
    ["circle", { cx: "6", cy: "18", r: "3" }],
    ["path", { d: "M18 9a9 9 0 0 1-9 9" }],
  ],
  "branches-dead": [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "m15 9-6 6" }],
    ["path", { d: "m9 9 6 6" }],
  ],
  "branches-stale": [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["path", { d: "M12 6v6l4 2" }],
  ],
};

const GROUP_TITLES = { branches: "Branches" };

const PAGE_CSS = `
[${SECTION_ATTRIBUTE}] {
  display: grid;
  gap: 2px;
  padding: 10px 12px;
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  direction: ltr;
  font-size: 13px;
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
  font-size: 12px;
  opacity: 0.65;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  width: calc(100% + 12px);
  margin: 0 -6px;
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
}
[${SECTION_ATTRIBUTE}] button.t3-rtl-repo-status-row {
  cursor: pointer;
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-group {
  margin-top: 6px;
  padding-top: 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.55;
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-group[data-separated] {
  border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
[${SECTION_ATTRIBUTE}] button.t3-rtl-repo-status-row:hover,
[${SECTION_ATTRIBUTE}] button.t3-rtl-repo-status-row:focus-visible {
  background: color-mix(in srgb, currentColor 8%, transparent);
  outline: none;
}
[${SECTION_ATTRIBUTE}] svg {
  flex: none;
  width: 14px;
  height: 14px;
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-count {
  margin-inline-start: auto;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-row[data-tone="warning"] .t3-rtl-repo-status-count,
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-row[data-tone="warning"] svg {
  color: var(--warning, #d97706);
}
[${SECTION_ATTRIBUTE}] div.t3-rtl-repo-status-row:focus-visible {
  background: color-mix(in srgb, currentColor 8%, transparent);
  outline: none;
}
.${TIP_CLASS} {
  --t3-rtl-tip-critical: var(--destructive, #dc2626);
  --t3-rtl-tip-high: #ea580c;
  --t3-rtl-tip-medium: var(--warning, #d97706);
  --t3-rtl-tip-low: var(--muted-foreground, #71717a);
  --t3-rtl-tip-muted: var(--muted-foreground, #71717a);
  --t3-rtl-tip-success: var(--success, #16a34a);
  --t3-rtl-tip-info: var(--info, #2563eb);
  position: fixed;
  inset: auto;
  top: 0;
  left: 0;
  z-index: 2147483647;
  box-sizing: border-box;
  width: max-content;
  min-width: 240px;
  max-width: min(360px, calc(100vw - 16px));
  max-height: calc(100vh - 16px);
  margin: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border, rgb(0 0 0 / 0.12));
  border-radius: 10px;
  background: var(--popover, #fff);
  color: var(--popover-foreground, #18181b);
  box-shadow: 0 12px 32px -10px rgb(0 0 0 / 0.35), 0 2px 6px -2px rgb(0 0 0 / 0.15);
  direction: ltr;
  font-size: 12px;
  line-height: 1.4;
  text-align: start;
  pointer-events: none;
  opacity: 0;
  transform: translateY(3px);
  transition: opacity 120ms ease-out, transform 120ms ease-out;
}
.${TIP_CLASS}:not([data-open]) {
  display: none;
}
.${TIP_CLASS}[data-shown] {
  opacity: 1;
  transform: none;
}
@media (prefers-reduced-motion: reduce) {
  .${TIP_CLASS} { transition: none; transform: none; }
}
.${TIP_CLASS} .t3-rtl-tip-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 9px 12px 8px;
  border-bottom: 1px solid var(--border, rgb(0 0 0 / 0.12));
}
.${TIP_CLASS} .t3-rtl-tip-title {
  font-size: 13px;
  font-weight: 600;
}
.${TIP_CLASS} .t3-rtl-tip-summary,
.${TIP_CLASS} .t3-rtl-tip-lead,
.${TIP_CLASS} .t3-rtl-tip-meta,
.${TIP_CLASS} .t3-rtl-tip-more,
.${TIP_CLASS} .t3-rtl-tip-note {
  color: var(--muted-foreground, #71717a);
}
.${TIP_CLASS} .t3-rtl-tip-summary {
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.${TIP_CLASS} .t3-rtl-tip-section {
  display: grid;
  gap: 2px;
  padding: 7px 12px 8px;
}
.${TIP_CLASS} .t3-rtl-tip-section + .t3-rtl-tip-section {
  border-top: 1px solid var(--border, rgb(0 0 0 / 0.12));
}
.${TIP_CLASS} .t3-rtl-tip-section-title {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted-foreground, #71717a);
}
.${TIP_CLASS} .t3-rtl-tip-chips,
.${TIP_CLASS} .t3-rtl-tip-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.${TIP_CLASS} .t3-rtl-tip-chips {
  margin: 2px 0 3px;
}
.${TIP_CLASS} .t3-rtl-tip-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 8px;
  row-gap: 2px;
  padding: 3px 0;
}
.${TIP_CLASS} .t3-rtl-tip-lead {
  font-variant-numeric: tabular-nums;
}
.${TIP_CLASS} .t3-rtl-tip-text {
  grid-column: 2;
  font-weight: 500;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}
.${TIP_CLASS} .t3-rtl-tip-item:not([data-lead]) .t3-rtl-tip-text {
  grid-column: 1 / -1;
}
.${TIP_CLASS} .t3-rtl-tip-sub {
  grid-column: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  min-width: 0;
}
.${TIP_CLASS} .t3-rtl-tip-item:not([data-lead]) .t3-rtl-tip-sub {
  grid-column: 1 / -1;
}
.${TIP_CLASS} .t3-rtl-tip-meta {
  font-size: 11px;
  overflow-wrap: anywhere;
}
.${TIP_CLASS} .t3-rtl-tip-badge {
  --t3-rtl-tip-tone: var(--t3-rtl-tip-muted);
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--t3-rtl-tip-tone) 35%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--t3-rtl-tip-tone) 14%, transparent);
  color: color-mix(in srgb, var(--t3-rtl-tip-tone) 75%, currentColor);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 16px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.${TIP_CLASS} .t3-rtl-tip-badge[data-tone="critical"] { --t3-rtl-tip-tone: var(--t3-rtl-tip-critical); }
.${TIP_CLASS} .t3-rtl-tip-badge[data-tone="high"] { --t3-rtl-tip-tone: var(--t3-rtl-tip-high); }
.${TIP_CLASS} .t3-rtl-tip-badge[data-tone="medium"] { --t3-rtl-tip-tone: var(--t3-rtl-tip-medium); }
.${TIP_CLASS} .t3-rtl-tip-badge[data-tone="low"] { --t3-rtl-tip-tone: var(--t3-rtl-tip-low); }
.${TIP_CLASS} .t3-rtl-tip-badge[data-tone="success"] { --t3-rtl-tip-tone: var(--t3-rtl-tip-success); }
.${TIP_CLASS} .t3-rtl-tip-badge[data-tone="info"] { --t3-rtl-tip-tone: var(--t3-rtl-tip-info); }
.${TIP_CLASS} .t3-rtl-tip-badge[data-label] {
  --t3-rtl-tip-tone: var(--t3-rtl-tip-label);
  /* A label can have any color, so its text leans toward the text color. */
  color: color-mix(in oklab, var(--t3-rtl-tip-label) 45%, currentColor);
}
/* An item with badges only keeps them on its line. */
.${TIP_CLASS} .t3-rtl-tip-item[data-inline] {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.${TIP_CLASS} .t3-rtl-tip-item[data-inline] .t3-rtl-tip-sub {
  flex: none;
}
.${TIP_CLASS} .t3-rtl-tip-more {
  padding-top: 2px;
  font-size: 11px;
}
.${TIP_CLASS} .t3-rtl-tip-note {
  padding: 7px 12px 8px;
  border-top: 1px solid var(--border, rgb(0 0 0 / 0.12));
  font-size: 11px;
}
`;

function buildRepoStatusPageSource() {
  return `(() => {
  const binding = ${JSON.stringify(REPO_STATUS_BINDING)};
  const receiver = ${JSON.stringify(RECEIVER)};
  const flag = ${JSON.stringify(PAGE_FLAG)};
  const attribute = ${JSON.stringify(SECTION_ATTRIBUTE)};
  const styleId = ${JSON.stringify(STYLE_ID)};
  const css = ${JSON.stringify(PAGE_CSS)};
  const icons = ${JSON.stringify(ICONS)};
  const groupTitles = ${JSON.stringify(GROUP_TITLES)};
  const linkKinds = ${JSON.stringify(Object.keys(PAGE_BY_KIND))};
  const refreshInterval = ${REFRESH_INTERVAL_MS};
  const tipClass = ${JSON.stringify(TIP_CLASS)};
  const tipDelay = ${TIP_DELAY_MS};
  if (window[flag]) return;
  Object.defineProperty(window, flag, { value: true });

  let current = null;
  let lastHref = location.href;
  let renderQueued = false;

  // The first two route segments name the thread. Other address changes,
  // such as an opened panel, keep the shown counts while they are checked.
  const routeKey = (href) => {
    try {
      const url = new URL(href);
      const route = url.hash.startsWith("#/") ? url.hash.slice(1).split("?")[0] : url.pathname;
      return route.split("/").filter(Boolean).slice(0, 2).join("/");
    } catch {
      return href;
    }
  };

  const notify = (message) => {
    const call = window[binding];
    if (typeof call === "function") call(JSON.stringify(message));
  };
  const request = (reason) => notify({ type: "check", path: location.href, reason });
  Object.defineProperty(window, ${JSON.stringify(CHECK)}, { value: request });

  const ensureStyle = () => {
    if (document.getElementById(styleId) || !document.head) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = css;
    document.head.appendChild(style);
  };

  const icon = (name) => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "lucide");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const [tag, attributes] of icons[name] || []) {
      const child = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, value);
      svg.appendChild(child);
    }
    return svg;
  };

  // One tooltip serves every row. It sits in the top layer when the browser
  // supports popovers, so no dialog or panel of T3 Code covers it. Text from
  // GitHub is set only as text.
  let tip = null;
  let tipAnchor = null;
  let tipTimer = 0;
  let tipHiddenAt = 0;

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  };

  const ago = (time) => {
    if (typeof time !== "number" || !Number.isFinite(time)) return "";
    const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
    if (minutes < 1) return "just now";
    const unit = (value, word) => value + " " + word + (value === 1 ? "" : "s") + " ago";
    if (minutes < 60) return unit(minutes, "minute");
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return unit(hours, "hour");
    const days = Math.floor(hours / 24);
    if (days < 60) return unit(days, "day");
    if (days < 730) return unit(Math.floor(days / 30), "month");
    return unit(Math.floor(days / 365), "year");
  };

  const badge = (data) => {
    const node = make("span", "t3-rtl-tip-badge", data.text);
    node.dir = "auto";
    if (data.tone) node.dataset.tone = data.tone;
    if (typeof data.color === "string" && /^[0-9a-f]{6}$/i.test(data.color)) {
      node.dataset.label = "";
      node.style.setProperty("--t3-rtl-tip-label", "#" + data.color);
    }
    return node;
  };

  const tipItem = (item) => {
    const node = make("div", "t3-rtl-tip-item");
    if (item.lead) {
      node.dataset.lead = "";
      node.appendChild(make("span", "t3-rtl-tip-lead", item.lead));
    }
    const text = make("span", "t3-rtl-tip-text", item.text);
    text.dir = "auto";
    node.appendChild(text);
    const meta = [...(item.meta || []), ago(item.time)].filter(Boolean).join(" · ");
    const badges = item.badges || [];
    if (!item.lead && !meta && badges.length) node.dataset.inline = "";
    if (meta || badges.length) {
      const sub = make("div", "t3-rtl-tip-sub");
      if (meta) {
        const metaNode = make("span", "t3-rtl-tip-meta", meta);
        metaNode.dir = "auto";
        sub.appendChild(metaNode);
      }
      for (const data of badges) sub.appendChild(badge(data));
      node.appendChild(sub);
    }
    return node;
  };

  const ensureTip = () => {
    if (tip && tip.isConnected) return tip;
    tip = make("div", tipClass);
    tip.id = tipClass;
    tip.setAttribute("role", "tooltip");
    if (typeof tip.showPopover === "function") tip.setAttribute("popover", "manual");
    document.body.appendChild(tip);
    return tip;
  };

  const fillTip = (detail) => {
    const box = ensureTip();
    box.replaceChildren();
    const head = make("div", "t3-rtl-tip-head");
    head.append(make("span", "t3-rtl-tip-title", detail.title), make("span", "t3-rtl-tip-summary", detail.summary));
    box.appendChild(head);
    for (const section of detail.sections || []) {
      const part = make("div", "t3-rtl-tip-section");
      if (section.title) part.appendChild(make("div", "t3-rtl-tip-section-title", section.title));
      if (section.chips && section.chips.length) {
        const chips = make("div", "t3-rtl-tip-chips");
        for (const chip of section.chips) chips.appendChild(badge(chip));
        part.appendChild(chips);
      }
      for (const item of section.items || []) part.appendChild(tipItem(item));
      if (section.more > 0) part.appendChild(make("div", "t3-rtl-tip-more", "and " + section.more + " more"));
      box.appendChild(part);
    }
    if (detail.note) box.appendChild(make("div", "t3-rtl-tip-note", detail.note));
  };

  // Beside the row, on the side with room, else below or above it, and
  // always inside the window.
  const placeTip = () => {
    if (!tip || !tipAnchor) return;
    const gap = 8;
    const margin = 8;
    const anchor = tipAnchor.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    let left;
    let top = anchor.top - gap;
    if (anchor.left - gap - width >= margin) {
      left = anchor.left - gap - width;
    } else if (anchor.right + gap + width <= innerWidth - margin) {
      left = anchor.right + gap;
    } else {
      left = anchor.left;
      top = anchor.bottom + gap + height <= innerHeight - margin ? anchor.bottom + gap : anchor.top - gap - height;
    }
    left = Math.min(Math.max(left, margin), Math.max(margin, innerWidth - width - margin));
    top = Math.min(Math.max(top, margin), Math.max(margin, innerHeight - height - margin));
    tip.style.left = Math.round(left) + "px";
    tip.style.top = Math.round(top) + "px";
  };

  const popoverOpen = (node) => {
    try {
      return node.matches(":popover-open");
    } catch {
      return false;
    }
  };

  const showTip = (anchor, detail) => {
    clearTimeout(tipTimer);
    if (!anchor.isConnected || !detail) return;
    if (tipAnchor && tipAnchor !== anchor) tipAnchor.removeAttribute("aria-describedby");
    fillTip(detail);
    tipAnchor = anchor;
    tip.setAttribute("data-open", "");
    if (tip.hasAttribute("popover") && !popoverOpen(tip)) {
      try {
        tip.showPopover();
      } catch {
        // A fixed tooltip with a high z-index still shows.
      }
    }
    placeTip();
    anchor.setAttribute("aria-describedby", tip.id);
    requestAnimationFrame(() => {
      if (tipAnchor === anchor) tip.setAttribute("data-shown", "");
    });
  };

  const hideTip = () => {
    clearTimeout(tipTimer);
    if (!tipAnchor) return;
    tipAnchor.removeAttribute("aria-describedby");
    tipAnchor = null;
    tipHiddenAt = Date.now();
    tip.removeAttribute("data-shown");
    tip.removeAttribute("data-open");
    if (popoverOpen(tip)) tip.hidePopover();
  };

  // Moving from one row to the next switches the tooltip at once.
  const scheduleTip = (anchor, detail) => {
    clearTimeout(tipTimer);
    const delay = tipAnchor || Date.now() - tipHiddenAt < 300 ? 0 : tipDelay;
    tipTimer = setTimeout(() => showTip(anchor, detail), delay);
  };

  const attachTip = (element, detail) => {
    element.addEventListener("pointerenter", () => scheduleTip(element, detail));
    element.addEventListener("pointerleave", hideTip);
    element.addEventListener("focus", () => {
      if (element.matches(":focus-visible")) showTip(element, detail);
    });
    element.addEventListener("blur", hideTip);
  };

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hideTip();
  }, true);
  window.addEventListener("scroll", hideTip, true);
  window.addEventListener("resize", hideTip);

  // The card holds a scroll area around one element with its sections. The
  // section goes after the last of them.
  const sectionContainer = (card) => {
    let node = card.querySelector('[data-slot="scroll-area-viewport"]') || card;
    const start = node;
    for (let depth = 0; node && depth < 8; depth += 1) {
      const children = Array.from(node.children).filter((child) => !child.hasAttribute(attribute));
      if (children.length !== 1) return children.length > 1 ? node : start;
      node = children[0];
    }
    return start;
  };

  const buildSection = (data, signature) => {
    const section = document.createElement("div");
    section.setAttribute(attribute, "");
    section.dataset.signature = signature;
    const head = document.createElement("div");
    head.className = "t3-rtl-repo-status-head";
    head.appendChild(icon("repo"));
    const name = document.createElement("span");
    name.textContent = data.repo || "";
    head.appendChild(name);
    section.appendChild(head);
    let group;
    let rowsBefore = 0;
    for (const row of data.rows) {
      if (row.group && row.group !== group) {
        const title = document.createElement("div");
        title.className = "t3-rtl-repo-status-group";
        // The line separates the group only from rows above it.
        if (rowsBefore > 0) title.dataset.separated = "";
        title.textContent = groupTitles[row.group] || row.group;
        section.appendChild(title);
      }
      group = row.group;
      rowsBefore += 1;
      // A row without a GitHub page, such as local branches, is not a button.
      const linked = linkKinds.includes(row.kind);
      const element = document.createElement(linked ? "button" : "div");
      element.className = "t3-rtl-repo-status-row";
      if (linked) element.type = "button";
      element.dataset.kind = row.kind;
      if (row.tone) element.dataset.tone = row.tone;
      element.appendChild(icon(row.kind));
      const label = document.createElement("span");
      label.textContent = row.label;
      const count = document.createElement("span");
      count.className = "t3-rtl-repo-status-count";
      count.textContent = row.count;
      element.append(label, count);
      if (row.detail) {
        // The keyboard reaches a row that is not a button for its tooltip.
        if (!linked) element.tabIndex = 0;
        attachTip(element, row.detail);
      }
      if (linked) {
        element.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          hideTip();
          notify({ type: "open", kind: row.kind });
        });
      }
      section.appendChild(element);
    }
    return section;
  };

  const render = () => {
    renderQueued = false;
    const rows = current && Array.isArray(current.rows) ? current.rows : [];
    const signature = rows.length ? JSON.stringify([current.repo, rows]) : "";
    const keep = new Set();
    if (signature) {
      ensureStyle();
      for (const card of document.querySelectorAll("[data-thread-details-card]")) {
        const container = sectionContainer(card);
        let section = Array.from(container.children).find((child) => child.hasAttribute(attribute));
        if (!section || section.dataset.signature !== signature || section !== container.lastElementChild) {
          if (section) section.remove();
          section = buildSection(current, signature);
          container.appendChild(section);
        }
        keep.add(section);
      }
    }
    for (const section of document.querySelectorAll("[" + attribute + "]")) {
      if (!keep.has(section)) section.remove();
    }
    // A rebuilt or removed section takes the row of an open tooltip with it.
    if (tipAnchor && !tipAnchor.isConnected) hideTip();
  };

  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  };

  window[receiver] = (data) => {
    if (!data || routeKey(data.path) !== routeKey(location.href)) return;
    current = data;
    scheduleRender();
  };

  const observer = new MutationObserver(() => {
    if (current?.rows?.length || document.querySelector("[" + attribute + "]")) scheduleRender();
  });
  const startObserving = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) startObserving();
  else document.addEventListener("DOMContentLoaded", startObserving, { once: true });

  setInterval(() => {
    if (location.href === lastHref) return;
    const threadChanged = routeKey(location.href) !== routeKey(lastHref);
    lastHref = location.href;
    if (threadChanged) {
      current = null;
      scheduleRender();
    }
    request("navigate");
  }, 1000);
  setInterval(() => {
    if (document.visibilityState === "visible") request("interval");
  }, refreshInterval);
  window.addEventListener("focus", () => request("focus"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") request("focus");
  });
  request("navigate");
})();`;
}

module.exports = {
  REPO_STATUS_BINDING,
  RECEIVER,
  SECTION_ATTRIBUTE,
  FRESH_MS,
  REFRESH_INTERVAL_MS,
  buildRepoStatusPageSource,
  buildRows,
  summarizeBranches,
  createRepoStatusService,
  fetchCounts,
  lookupThreadFolder,
  opensSqliteReadOnly,
  parseGitHubRemote,
  parseThreadLocation,
  parseThreadPath,
  repositoryUrl,
};

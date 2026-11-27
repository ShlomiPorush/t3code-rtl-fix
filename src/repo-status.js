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
// The page starts off and waits for the launcher to turn it on, so a new
// document under a turned-off setting never checks.
const ENABLE = "__t3RtlFixRepoStatusEnabled";
// The drag type of T3 Code's own pull request rows. The composer shows a
// drop of it as a reference to the pull request.
const PULL_REQUEST_DRAG_TYPE = "application/x-t3code-pull-request";
const SECTION_ATTRIBUTE = "data-t3-rtl-repo-status";
const STYLE_ID = "t3-rtl-fix-repo-status-style";
const TIP_CLASS = "t3-rtl-repo-status-tip";
// A pointer that rests on a row this long opens its tooltip.
const TIP_DELAY_MS = 250;
// While one tooltip is open, a pointer that rests on another row this long
// moves the tooltip there.
const TIP_SWITCH_DELAY_MS = 120;
// A pointer that leaves a row or its tooltip closes the tooltip after this
// long, unless it reaches the tooltip or the row first.
const TIP_HIDE_DELAY_MS = 200;

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
// T3 Code keeps the new threads that have no message yet under this key.
const DRAFTS_KEY = "t3code:composer-drafts:v1";
const DAY_MS = 24 * 60 * 60 * 1000;
// A tooltip list holds up to one page of the GitHub API, and scrolls.
const LIST_ITEMS = 100;
// A list longer than this ends with a line that opens it on GitHub.
const LIST_LINE_MIN = 5;
// Dependabot severities are counted from one page of alerts.
const DEPENDABOT_PAGE_SIZE = 100;
const LABEL_COLOR = /^[0-9a-f]{6}$/i;
const AVATAR_URL = /^https:\/\/avatars\.githubusercontent\.com\/[^\s"'<>]{1,500}$/;
const SEVERITIES = ["critical", "high", "medium", "low"];
const SEVERITY_LABELS = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
// GitHub names severities differently for each kind of alert.
const SEVERITY_ALIASES = { moderate: "medium", error: "high", warning: "medium", note: "low" };
const DEPLOYMENT_PAGE_SIZE = 100;
const DEPLOYMENT_PAGES = 5;
const ENVIRONMENTS_SHOWN = 50;
const STATUSES_PER_DEPLOYMENT = 5;
const DEPLOYMENTS_PER_ENVIRONMENT = 10;
const DEPLOYMENT_STATES = {
  ACTIVE: { text: "Active", tone: "success" },
  SUCCESS: { text: "Deployed", tone: "success" },
  FAILURE: { text: "Failed", tone: "critical" },
  ERROR: { text: "Error", tone: "critical" },
  IN_PROGRESS: { text: "In progress", tone: "info" },
  QUEUED: { text: "Queued", tone: "info" },
  PENDING: { text: "Pending", tone: "info" },
  WAITING: { text: "Waiting", tone: "medium" },
  INACTIVE: { text: "Inactive", tone: "muted" },
  ABANDONED: { text: "Abandoned", tone: "muted" },
  DESTROYED: { text: "Destroyed", tone: "muted" },
};
const UNKNOWN_DEPLOYMENT_STATE = { text: "Unknown", tone: "muted" };
const REVIEW_BADGES = {
  APPROVED: { text: "Approved", tone: "success" },
  CHANGES_REQUESTED: { text: "Changes requested", tone: "critical" },
  REVIEW_REQUIRED: { text: "Review required", tone: "muted" },
};

const COUNTS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: ${LIST_ITEMS}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes { number title updatedAt author { login avatarUrl(size: 40) } labels(first: 3) { nodes { name color } } }
    }
    pullRequests(states: OPEN, first: ${LIST_ITEMS}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes { number title updatedAt isDraft reviewDecision headRefName baseRefName author { login avatarUrl(size: 40) } }
    }
    hasVulnerabilityAlertsEnabled
    vulnerabilityAlerts(states: OPEN, first: ${DEPENDABOT_PAGE_SIZE}) {
      totalCount
      nodes { number securityVulnerability { severity package { name } } }
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

const RECENT_DEPLOYMENTS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    deployments(first: ${DEPLOYMENT_PAGE_SIZE}, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { environment createdAt }
    }
  }
}`;

function deploymentsQuery(count) {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const variables = indexes.map((index) => `, $e${index}: String!`).join("");
  const fields = indexes.map((index) => `
    n${index}: environments(names: [$e${index}], first: 1) { nodes { name } }
    e${index}: deployments(environments: [$e${index}], first: ${DEPLOYMENTS_PER_ENVIRONMENT}, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { state createdAt commitOid ref { name } creator { login } statuses(first: ${STATUSES_PER_DEPLOYMENT}) { nodes { environmentUrl } } }
    }`).join("");
  return `query($owner: String!, $name: String!${variables}) {
  repository(owner: $owner, name: $name) {${fields}
  }
}`;
}

// T3 Code routes a thread as /<environmentId>/<threadId>, and a new thread
// before its first message as /draft/<draftId>.
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
  if (segments[0] === "draft") return { draftId: threadId };
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

// The items and lists in a tooltip link to pages of the repository shown.
// A link is the part of the address after the repository, such as
// "issues/12". The launcher opens only the links of the rows it sent.
function numberLink(page, number) {
  return Number.isInteger(number) && number > 0 ? `${page}/${number}` : null;
}

function branchLink(name) {
  if (typeof name !== "string" || !name) return null;
  const parts = name.split("/");
  // Git refuses such names, so they come only from a broken answer. A dot
  // part would move the address out of the branch path.
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  try {
    return `tree/${parts.map(encodeURIComponent).join("/")}`;
  } catch {
    // A lone surrogate cannot be encoded.
    return null;
  }
}

function environmentLink(name) {
  try {
    return `deployments/activity_log?environments_filter=${encodeURIComponent(name)}`;
  } catch {
    return null;
  }
}

function siteUrl(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
}

function isSiteUrl(link) {
  return link.startsWith("https://");
}

function withLink(item, link) {
  return link ? { ...item, link } : item;
}

function linksOf(rows) {
  const links = new Set();
  for (const row of rows) {
    if (row.link) links.add(row.link);
    for (const section of row.detail?.sections || []) {
      if (section.link) links.add(section.link);
      for (const item of section.items || []) {
        if (item.link) links.add(item.link);
        if (item.url) links.add(item.url);
      }
    }
  }
  return links;
}

function linkUrl(repo, link) {
  return `https://github.com/${repo.owner}/${repo.name}/${link}`;
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
    else copies.set(key, { name, time, skip, github: key.startsWith("remote:") });
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
    .map(({ name, time, github }) => ({ name, time, days: Math.floor((now - time) / DAY_MS), github }));

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
            tracking: Boolean(branch.upstream || branch.tracking),
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
// are. total is the full count, which can be larger than the list read. link
// names the page with the whole list, which the last line of a long list
// opens.
// partial marks a list read from one page of a longer one, whose full count
// is unknown.
function listSection(list, total, toItem, title, link, partial = false) {
  const read = Array.isArray(list) ? list : [];
  const items = read.slice(0, LIST_ITEMS);
  const section = { items: items.map(toItem), more: Math.max(total - items.length, 0) };
  if (title) section.title = title;
  if (partial) section.partial = true;
  // The line stands for the items left out, or for the whole list when none
  // are. The page it opens must hold each of them, so each needs a page of
  // its own there, such as an alert with a number.
  const hasLine = section.more > 0 || partial || items.length > LIST_LINE_MIN;
  if (link && hasLine) {
    const covered = section.more > 0 ? read.slice(LIST_ITEMS).map(toItem) : section.items;
    if (covered.every((item) => item.link)) section.link = link;
  }
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
      listSection(issues.items, issues.value, (issue) => withLink({
        lead: `#${issue.number}`,
        text: issue.title,
        meta: compact([issue.author]),
        row: { icon: "issue-open", author: issue.author, avatar: issue.avatar },
        time: issue.time,
        badges: (issue.labels || []).map((label) => ({ text: label.name, color: label.color })),
      }, numberLink("issues", issue.number)), null, "issues"),
    ],
  };
}

function pullDetail(pulls) {
  return {
    title: "Pull requests",
    summary: `${countText(pulls)} open`,
    sections: [
      listSection(pulls.items, pulls.value, (pull) => withLink({
        lead: `#${pull.number}`,
        text: pull.title,
        meta: compact([pull.author]),
        row: { icon: pull.draft ? "pull-draft" : "pull-open", author: pull.author, avatar: pull.avatar },
        time: pull.time,
        badges: compact([
          pull.draft ? { text: "Draft", tone: "muted" } : null,
          REVIEW_BADGES[pull.review] || null,
        ]),
        // Dragged into the composer, it becomes T3 Code's own pull request
        // reference. The page adds the address it links to.
        pull: pull.head && pull.base
          ? { number: pull.number, title: pull.title || `#${pull.number}`, headBranch: pull.head, baseBranch: pull.base, isDraft: pull.draft }
          : null,
      }, numberLink("pull", pull.number)), null, "pulls"),
    ],
  };
}

function securityDetail(total, { dependabot, codeScanning, secretScanning }) {
  const sections = [];
  const notes = [];
  if (dependabot) {
    const alerts = dependabot.alerts || [];
    sections.push({
      ...listSection([...alerts].sort(bySeverity), dependabot.value, (alert) => withLink({
        text: alert.package || "Unknown package",
        badges: compact([severityBadge(alert.severity)]),
      }, numberLink("security/dependabot", alert.number)), `Dependabot · ${countText(dependabot)}`, "security/dependabot"),
      chips: alerts.length > 1 ? severityChips(alerts) : [],
    });
    if (alerts.length < dependabot.value) {
      notes.push(`Severities count the first ${alerts.length} Dependabot alerts.`);
    }
  }
  if (codeScanning) {
    const alerts = codeScanning.alerts || [];
    sections.push({
      ...listSection([...alerts].sort(bySeverity), codeScanning.value, (alert) => withLink({
        text: alert.rule || "Unnamed rule",
        meta: compact([alert.path]),
        badges: compact([severityBadge(alert.severity)]),
      }, numberLink("security/code-scanning", alert.number)), `Code scanning · ${countText(codeScanning)}`, "security/code-scanning", codeScanning.capped),
      chips: alerts.length > 1 ? severityChips(alerts) : [],
    });
  }
  if (secretScanning) {
    sections.push(listSection(secretScanning.alerts, secretScanning.value, (alert) => withLink({
      text: alert.type || "Unknown secret type",
    }, numberLink("security/secret-scanning", alert.number)), `Secret scanning · ${countText(secretScanning)}`, "security/secret-scanning", secretScanning.capped));
  }
  const detail = { title: "Security alerts", summary: `${countText(total)} open`, sections };
  if (notes.length) detail.note = notes.join(" ");
  return detail;
}

function deploymentState(deployment) {
  return Object.hasOwn(DEPLOYMENT_STATES, deployment.state ?? "") ? DEPLOYMENT_STATES[deployment.state] : UNKNOWN_DEPLOYMENT_STATE;
}

function deploymentItem(deployment) {
  const item = {
    text: deployment.ref || deployment.commit || "Unknown commit",
    meta: compact([deployment.creator, deployment.ref ? deployment.commit : ""]),
    time: deployment.time,
    badges: [deploymentState(deployment)],
  };
  return deployment.url ? { ...item, url: deployment.url } : item;
}

function deploymentRow(environment) {
  const [latest] = environment.deployments;
  const state = deploymentState(latest);
  const row = {
    group: "deployments",
    kind: "deployment",
    key: `deployment:${environment.name}`,
    label: environment.name,
    count: state.text,
    tone: state.tone,
    time: latest.time,
    detail: {
      title: environment.name,
      summary: "Latest deployments",
      sections: [listSection(environment.deployments, environment.deployments.length, deploymentItem)],
    },
  };
  const link = environmentLink(environment.name);
  return link ? { ...row, link } : row;
}

function localBadge(branch) {
  if (branch.deleted) return { text: "Deleted on GitHub", tone: "critical" };
  if (!branch.tracking) return { text: "No upstream", tone: "muted" };
  if (branch.track === "gone") return { text: "Upstream gone", tone: "critical" };
  if (!branch.track) return { text: "Up to date", tone: "success" };
  return { text: branch.track, tone: branch.track.includes("behind") ? "medium" : "info" };
}

const branchItem = (branch) => ({ text: branch.name, time: branch.time });
// A branch on GitHub links to its files there.
const githubBranchItem = (branch) => withLink(branchItem(branch), branchLink(branch.name));
const ALL_BRANCHES = "branches/all";
const UNKNOWN_NOTE = "Some branches could not be checked, so there may be more.";

// A local branch links to the GitHub branch it tracks, unless that branch is
// gone.
function localLink(branch) {
  if (!branch.upstream || branch.deleted || branch.track === "gone") return null;
  return branchLink(branch.upstream);
}

function branchDetails(branches) {
  const details = {};
  const remote = countValue(branches.remote);
  if (remote) {
    details.remote = {
      title: "Remote branches",
      summary: `${countText(remote)} on GitHub`,
      sections: [
        listSection(remote.branches, remote.value, (branch) => ({
          ...githubBranchItem(branch),
          badges: branch.merged ? [{ text: "Merged", tone: "success" }] : [],
        }), null, ALL_BRANCHES),
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
        listSection(local.branches, local.value, (branch) => withLink({
          ...branchItem(branch),
          badges: [localBadge(branch)],
        }, localLink(branch))),
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
          ? listSection(dead.merged, dead.merged.length, githubBranchItem, "Merged on GitHub", ALL_BRANCHES)
          : null,
        dead.deleted.length
          ? listSection(dead.deleted, dead.deleted.length, branchItem, "Deleted on GitHub")
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
      sections: [
        listSection(
          stale.branches,
          stale.branches.length,
          (branch) => (branch.github ? githubBranchItem(branch) : branchItem(branch)),
          null,
          ALL_BRANCHES,
        ),
      ],
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
  for (const environment of status.deployments || []) {
    rows.push(deploymentRow(environment));
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

function avatarOf(value) {
  return typeof value === "string" && AVATAR_URL.test(value) ? value : "";
}

function timeOf(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : null;
}

function nodesOf(connection) {
  return Array.isArray(connection?.nodes) ? connection.nodes.filter(Boolean) : [];
}

// An alert's number names its page on GitHub.
function alertNumber(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
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
      avatar: avatarOf(issue.author?.avatarUrl),
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
      avatar: avatarOf(pull.author?.avatarUrl),
      time: timeOf(pull.updatedAt),
      draft: pull.isDraft === true,
      review: Object.hasOwn(REVIEW_BADGES, pull.reviewDecision ?? "") ? pull.reviewDecision : null,
      // T3 Code's pull request reference needs both branches.
      head: text(pull.headRefName, 255),
      base: text(pull.baseRefName, 255),
    }));
  return count;
}

function readDependabot(connection) {
  const count = totalCount(connection);
  if (!count) return null;
  count.alerts = nodesOf(connection).map((alert) => ({
    number: alertNumber(alert.number),
    severity: readSeverity(alert.securityVulnerability?.severity),
    package: text(alert.securityVulnerability?.package?.name, 100),
  }));
  return count;
}

// Only the fields the tooltip shows are kept. A secret scanning alert also
// holds the secret it found, which never leaves this function.
const ALERT_READERS = {
  "code-scanning": (alert) => ({
    number: alertNumber(alert?.number),
    severity: readSeverity(alert?.rule?.security_severity_level || alert?.rule?.severity),
    rule: text(alert?.rule?.description || alert?.rule?.name || alert?.rule?.id, 200),
    path: text(alert?.most_recent_instance?.location?.path, 200),
  }),
  "secret-scanning": (alert) => ({
    number: alertNumber(alert?.number),
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
        // Any upstream, such as a branch on another remote.
        tracking: Boolean(remoteRef),
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
  const [graphqlResult, codeScanning, secretScanning, local, deployments] = await Promise.all([
    graphql,
    alerts("code-scanning"),
    alerts("secret-scanning"),
    readLocalBranches(run, folder),
    fetchDeployments(run, repo, now),
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
    dependabot: repository.hasVulnerabilityAlertsEnabled === false ? null : readDependabot(repository.vulnerabilityAlerts),
    codeScanning,
    secretScanning,
    branches: readBranches(repository, local, now),
    deployments,
  };
}

async function fetchDeployments(run, repo, now) {
  const graphql = (query, variables) =>
    run("gh", [
      "api",
      "--hostname",
      "github.com",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${repo.owner}`,
      "-f",
      `name=${repo.name}`,
      ...variables,
    ]);
  const recentSince = now - STALE_DAYS * DAY_MS;
  const names = new Map();
  let after = null;
  for (let page = 0; page < DEPLOYMENT_PAGES; page += 1) {
    const connection = parseJson((await graphql(RECENT_DEPLOYMENTS_QUERY, after ? ["-f", `after=${after}`] : [])).stdout)?.data?.repository?.deployments;
    if (!connection) {
      if (page === 0) return null;
      break;
    }
    const recent = nodesOf(connection).filter((deployment) => timeOf(deployment.createdAt) >= recentSince);
    for (const { environment } of recent) {
      if (typeof environment === "string" && environment !== "" && !names.has(environment.toLowerCase())) names.set(environment.toLowerCase(), environment);
    }
    const { hasNextPage, endCursor } = connection.pageInfo || {};
    if (recent.length < nodesOf(connection).length || !hasNextPage || typeof endCursor !== "string") break;
    after = endCursor;
  }
  const picked = [...names.values()].slice(0, ENVIRONMENTS_SHOWN);
  if (picked.length === 0) return [];
  const variables = picked.flatMap((name, index) => ["-f", `e${index}=${name}`]);
  const answer = parseJson((await graphql(deploymentsQuery(picked.length), variables)).stdout)?.data?.repository;
  return answer ? readEnvironments(picked, answer, now) : null;
}

function readEnvironments(names, answer, now) {
  const recentSince = now - STALE_DAYS * DAY_MS;
  return names
    .map((name, index) => ({
      name: text(nodesOf(answer[`n${index}`])[0]?.name, 255),
      deployments: nodesOf(answer[`e${index}`]).map(readDeployment),
    }))
    .filter(({ name, deployments: [latest] }) => name && latest && latest.time >= recentSince && latest.state !== "DESTROYED")
    .sort((a, b) => b.deployments[0].time - a.deployments[0].time);
}

function readDeployment(node) {
  return {
    state: typeof node.state === "string" ? node.state : null,
    time: timeOf(node.createdAt),
    ref: text(node.ref?.name, 255),
    commit: /^[0-9a-f]{40}$/.test(node.commitOid ?? "") ? node.commitOid.slice(0, 7) : "",
    creator: text(node.creator?.login, 100),
    url: siteUrl(nodesOf(node.statuses).map((status) => status.environmentUrl).find((address) => typeof address === "string" && address !== "")),
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
                   p.workspace_root AS root, t.project_id AS project
            FROM orchestration_v2_projection_threads t
            LEFT JOIN projection_projects p ON p.project_id = t.project_id
            WHERE t.thread_id = ?`,
    project: "SELECT workspace_root AS root, project_id AS project FROM projection_projects WHERE project_id = ? AND deleted_at IS NULL",
  },
  {
    file: "state.sqlite",
    query: `SELECT t.worktree_path AS worktree, p.workspace_root AS root, t.project_id AS project
            FROM projection_threads t
            JOIN projection_projects p ON p.project_id = t.project_id
            WHERE t.thread_id = ?`,
    project: "SELECT workspace_root AS root, project_id AS project FROM projection_projects WHERE project_id = ? AND deleted_at IS NULL",
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
// holds it open while T3 Code migrates or checkpoints it. kind names the
// query: "query" for a thread, "project" for a project. It gives the folders
// and the project, which T3 Code needs to open a pull request in its panel.
function lookupFolders(databaseDirectory, kind, id) {
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
    const row = database.prepare(source[kind]).get(id);
    if (!row) return null;
    // A worktree that was removed after its branch merged can leave its
    // folder behind, so the project folder is the fallback.
    const folders = [...new Set([row.worktree, row.root].filter(Boolean))];
    if (folders.length === 0) return null;
    return { folders, projectId: typeof row.project === "string" && row.project ? row.project : null };
  } finally {
    database.close();
  }
}

function lookupThreadFolder(databaseDirectory, threadId) {
  return lookupFolders(databaseDirectory, "query", threadId);
}

// A new thread is not in the database before its first message. Its project
// is, and a worktree picked for it belongs to the same repository.
function lookupProjectFolder(databaseDirectory, projectId) {
  return lookupFolders(databaseDirectory, "project", projectId);
}

function openExternal(run, url) {
  if (process.platform === "win32") {
    return run(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe"), ["url.dll,FileProtocolHandler", url]);
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
  findProjectFolder = (projectId) => lookupProjectFolder(databaseDirectory, projectId),
  open = (url) => openExternal(run, url),
  enabled: initiallyEnabled = true,
  onCounts = () => {},
} = {}) {
  const sessions = new Map();
  // Turning the section off or on starts a new generation. Work that began
  // in an earlier one shows nothing and opens nothing.
  let enabled = initiallyEnabled;
  let generation = 0;
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

  // target is a thread, or the project of a new thread.
  async function resolveRepository(target) {
    const found = await cached(
      folders,
      JSON.stringify([target.kind, target.id]),
      // A thread keeps its folder. The page names any project for a new
      // thread, so the project is checked each time.
      target.kind === "project" ? 0 : LOCATION_CACHE_MS,
      () => (target.kind === "project" ? findProjectFolder(target.id) : findThreadFolder(target.id)),
      false,
    );
    for (const folder of found?.folders || []) {
      const repo = await cached(remotes, folder, LOCATION_CACHE_MS, async () => {
        const result = await run("git", ["-C", folder, "remote", "get-url", "origin"]);
        if (result.error?.code === "ENOENT") throw new Error("the git command was not found");
        return parseGitHubRemote(result.stdout);
      });
      // The folder also lists the local branches.
      if (repo) return { ...repo, folder, projectId: found.projectId ?? null };
    }
    return null;
  }

  // Resolves to whether the page took the rows. A page that moved to another
  // thread or project keeps the rows it shows.
  async function push(sessionId, data) {
    const expression = `(() => { const receive = window[${JSON.stringify(RECEIVER)}]; return typeof receive === "function" && receive(${JSON.stringify(data)}) === true; })()`;
    const response = await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
    return response?.result?.value === true;
  }

  function loadCounts(repo, reason) {
    const maxAge = reason === "interval" ? REFRESH_INTERVAL_MS - 30 * 1000 : FRESH_MS;
    // Local branches belong to a folder, so two clones of one repository on
    // GitHub keep separate entries.
    return cached(counts, JSON.stringify([repo.slug, repo.folder]), maxAge, async () => {
      const found = await fetchCounts(run, repo, { folder: repo.folder, now: now() });
      onCounts(repo.slug, found);
      return found;
    });
  }

  // A new thread names its project, which the page reads from T3 Code's
  // drafts. The project of a draft can change while its address stays.
  function targetOf(pagePath, project) {
    const thread = parseThreadLocation(pagePath);
    if (thread?.threadId) return { kind: "thread", id: thread.threadId };
    if (thread?.draftId && typeof project === "string" && SAFE_ID.test(project)) {
      return { kind: "project", id: project };
    }
    return null;
  }

  async function check(sessionId, pagePath, reason, project) {
    const target = targetOf(pagePath, project);
    const session = sessions.get(sessionId) || {};
    sessions.set(sessionId, session);
    const request = (session.request || 0) + 1;
    session.request = request;
    const startedIn = generation;
    // The rows shown stay clickable while the same thread refreshes.
    const key = target ? JSON.stringify([target.kind, target.id]) : null;
    if (session.target !== key) {
      session.target = key;
      session.repo = null;
      session.links = new Set();
    }
    // A newer check may replace this one at any await.
    const current = () => session.request === request && startedIn === generation && enabled;
    let rows = [];
    let repo = null;
    if (target) {
      try {
        repo = await resolveRepository(target);
        if (!current()) return;
        if (repo) rows = buildRows(await loadCounts(repo, reason));
      } catch (error) {
        logOnce(error.message);
        rows = [];
      }
    }
    if (!current()) return;
    const shown = rows.length > 0 ? repo : null;
    const accepted = await push(sessionId, {
      path: pagePath,
      project: project ?? null,
      repo: shown?.slug || null,
      // The page opens a pull request in T3 Code's panel for this project.
      projectId: shown?.projectId || null,
      rows,
    });
    // The links are those of the rows the page shows. A page that did not
    // take the rows still shows the earlier ones, and rows it took stay
    // shown even when a newer check has started.
    // Rows the page took stay clickable even when a newer check has started,
    // but not after the section was turned off or on.
    if (accepted && startedIn === generation && enabled) {
      session.repo = shown;
      session.links = linksOf(rows);
    }
  }

  async function handle(sessionId, payload) {
    if (!enabled) return;
    const message = parseJson(payload);
    if (!message || typeof message !== "object") return;
    if (message.type === "check" && typeof message.path === "string") {
      const project = typeof message.project === "string" ? message.project.slice(0, 256) : null;
      await check(sessionId, message.path.slice(0, 2048), String(message.reason || ""), project);
      return;
    }
    if (message.type === "open") {
      const session = sessions.get(sessionId);
      // A click on a row or link shown before another thread's counts
      // arrived names the earlier repository, and is ignored.
      if (!session?.repo || message.repo !== session.repo.slug) return;
      // A link is opened only when it is one of the links sent to the page.
      const url = typeof message.link === "string"
        ? session.links.has(message.link) ? isSiteUrl(message.link) ? message.link : linkUrl(session.repo, message.link) : null
        : repositoryUrl(session.repo, message.kind);
      if (url && enabled) await open(url);
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
    await tellPage(sessionId);
  }

  function tellPage(sessionId) {
    return send(
      "Runtime.evaluate",
      { expression: `(() => { const enable = window[${JSON.stringify(ENABLE)}]; if (typeof enable === "function") enable(${enabled ? "true" : "false"}); })()` },
      sessionId,
    );
  }

  function setEnabled(value) {
    const next = value === true;
    if (next === enabled) return;
    enabled = next;
    generation += 1;
    for (const session of sessions.values()) {
      session.repo = null;
      session.links = new Set();
    }
    for (const sessionId of attached) {
      tellPage(sessionId).catch((error) => logOnce(`the page could not be told: ${error.message}`));
    }
  }

  // A reloaded page loses the binding. The launcher adds it again when the
  // new document is ready, and the page then checks again. The Runtime domain
  // would keep it, but would also hold T3 Code's console objects.
  async function reattach(sessionId) {
    if (!attached.has(sessionId)) return;
    await send("Runtime.addBinding", { name: REPO_STATUS_BINDING }, sessionId);
    // Turning the page on also checks.
    await tellPage(sessionId);
  }

  function forget(sessionId) {
    sessions.delete(sessionId);
    attached.delete(sessionId);
  }

  return { attach, reattach, handle, forget, setEnabled };
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
  "issue-open": [
    ["circle", { cx: "12", cy: "12", r: "10" }],
    ["circle", { cx: "12", cy: "12", r: "1" }],
  ],
  "pull-open": [
    ["circle", { cx: "5", cy: "6", r: "3" }],
    ["path", { d: "M5 9v12" }],
    ["circle", { cx: "19", cy: "18", r: "3" }],
    ["path", { d: "m15 9-3-3 3-3" }],
    ["path", { d: "M12 6h5a2 2 0 0 1 2 2v7" }],
  ],
  "pull-draft": [
    ["circle", { cx: "18", cy: "18", r: "3" }],
    ["circle", { cx: "6", cy: "6", r: "3" }],
    ["path", { d: "M18 6V5" }],
    ["path", { d: "M18 11v-1" }],
    ["line", { x1: "6", x2: "6", y1: "9", y2: "21" }],
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
  deployment: [
    ["path", { d: "M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" }],
    ["path", { d: "m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" }],
    ["path", { d: "M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" }],
    ["path", { d: "M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" }],
  ],
};

const GITHUB_MARK =
  "M8 0C3.58 0 0 3.58 0 8C0 11.54 2.29 14.53 5.47 15.59C5.87 15.66 6.02 15.42 6.02 15.21C6.02 15.02 6.01 14.39 6.01 13.72C4 14.09 3.48 13.23 3.32 12.78C3.23 12.55 2.84 11.84 2.5 11.65C2.22 11.5 1.82 11.13 2.49 11.12C3.12 11.11 3.57 11.7 3.72 11.94C4.44 13.15 5.59 12.81 6.05 12.6C6.12 12.08 6.33 11.73 6.56 11.53C4.78 11.33 2.92 10.64 2.92 7.58C2.92 6.71 3.23 5.99 3.74 5.43C3.66 5.23 3.38 4.41 3.82 3.31C3.82 3.31 4.49 3.1 6.02 4.13C6.66 3.95 7.34 3.86 8.02 3.86C8.7 3.86 9.38 3.95 10.02 4.13C11.55 3.09 12.22 3.31 12.22 3.31C12.66 4.41 12.38 5.23 12.3 5.43C12.81 5.99 13.12 6.7 13.12 7.58C13.12 10.65 11.25 11.33 9.47 11.53C9.76 11.78 10.01 12.26 10.01 13.01C10.01 14.08 10 14.94 10 15.21C10 15.42 10.15 15.67 10.55 15.59C13.71 14.53 16 11.53 16 8C16 3.58 12.42 0 8 0Z";

const GROUP_TITLES = { branches: "Branches", deployments: "Deployments" };

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
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-row[data-tone="warning"] svg,
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-row[data-tone="medium"] .t3-rtl-repo-status-count {
  color: var(--warning, #d97706);
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-row[data-tone="success"] .t3-rtl-repo-status-count {
  color: var(--success, #16a34a);
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-row[data-tone="critical"] .t3-rtl-repo-status-count {
  color: var(--destructive, #dc2626);
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-row[data-tone="info"] .t3-rtl-repo-status-count {
  color: var(--info, #2563eb);
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-row[data-tone="muted"] .t3-rtl-repo-status-count {
  opacity: 0.6;
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-age {
  flex: none;
  margin-inline-start: auto;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  opacity: 0.55;
}
[${SECTION_ATTRIBUTE}] .t3-rtl-repo-status-age + .t3-rtl-repo-status-count {
  margin-inline-start: 0;
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
  scrollbar-width: thin;
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
/* The pointer can move into an open tooltip to click its links. */
.${TIP_CLASS}[data-shown] {
  opacity: 1;
  transform: none;
  pointer-events: auto;
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
.${TIP_CLASS} .t3-rtl-tip-item {
  margin: 0 -6px;
  padding: 3px 6px;
  border-radius: 6px;
}
.${TIP_CLASS} a.t3-rtl-tip-item {
  color: inherit;
  text-decoration: none;
  cursor: pointer;
}
/* An item that is not a link can still be dragged into the composer. */
.${TIP_CLASS} div.t3-rtl-tip-item[draggable="true"] {
  cursor: grab;
}
.${TIP_CLASS} a.t3-rtl-tip-item:hover,
.${TIP_CLASS} .t3-rtl-tip-item:focus-visible {
  background: color-mix(in srgb, currentColor 8%, transparent);
  outline: none;
}
.${TIP_CLASS}:has(.t3-rtl-tip-item[data-row]) {
  width: 20rem;
}
.${TIP_CLASS} .t3-rtl-tip-item[data-row] {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  margin: 0 -8px;
  padding: 4px 8px;
}
.${TIP_CLASS} .t3-rtl-tip-item[data-row] .t3-rtl-tip-badge {
  flex-shrink: 1;
  min-width: 1.5rem;
}
.${TIP_CLASS} .t3-rtl-row-state {
  flex: none;
  width: 1rem;
  height: 1rem;
}
.${TIP_CLASS} .t3-rtl-row-body {
  flex: 1;
  min-width: 0;
}
.${TIP_CLASS} .t3-rtl-row-line,
.${TIP_CLASS} .t3-rtl-row-meta {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  min-width: 0;
}
.${TIP_CLASS} .t3-rtl-row-number {
  flex: none;
  color: var(--muted-foreground, #71717a);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  line-height: 1rem;
  font-variant-numeric: tabular-nums;
}
.${TIP_CLASS} .t3-rtl-row-title,
.${TIP_CLASS} .t3-rtl-row-author,
.${TIP_CLASS} .t3-rtl-row-repo {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${TIP_CLASS} .t3-rtl-row-title {
  font-size: 0.875rem;
  line-height: 1.25rem;
}
.${TIP_CLASS} .t3-rtl-row-meta {
  overflow: hidden;
  color: var(--muted-foreground, #71717a);
  font-size: 0.6875rem;
  line-height: 1rem;
}
.${TIP_CLASS} .t3-rtl-row-actor {
  display: flex;
  flex-shrink: 0.2;
  align-items: baseline;
  gap: 0.375rem;
  min-width: 0;
}
.${TIP_CLASS} .t3-rtl-row-avatar {
  flex: none;
  align-self: center;
  width: 1rem;
  height: 1rem;
  border-radius: 999px;
  background: var(--muted, transparent);
  object-fit: cover;
}
.${TIP_CLASS} .t3-rtl-row-author {
  color: var(--foreground, currentColor);
  font-weight: 500;
}
.${TIP_CLASS} .t3-rtl-row-repo {
  flex-shrink: 20;
}
.${TIP_CLASS} .t3-rtl-row-provider {
  flex: none;
  width: 0.75rem;
  height: 0.75rem;
}
.${TIP_CLASS} .t3-rtl-row-time {
  flex: none;
  margin-inline-start: auto;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.${TIP_CLASS} a.t3-rtl-tip-more {
  justify-self: start;
  border-radius: 4px;
  text-decoration: none;
  cursor: pointer;
}
.${TIP_CLASS} a.t3-rtl-tip-more:hover,
.${TIP_CLASS} a.t3-rtl-tip-more:focus-visible {
  color: inherit;
  text-decoration: underline;
  outline: none;
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
  const tipSwitchDelay = ${TIP_SWITCH_DELAY_MS};
  const tipHideDelay = ${TIP_HIDE_DELAY_MS};
  const draftsKey = ${JSON.stringify(DRAFTS_KEY)};
  const PULL_REQUEST_TYPE = ${JSON.stringify(PULL_REQUEST_DRAG_TYPE)};
  const listLineMin = ${LIST_LINE_MIN};
  if (window[flag]) return;
  Object.defineProperty(window, flag, { value: true });

  let current = null;
  let currentSignature = "";
  let enabled = false;
  // Changes each time the section is turned off or on. A pull request click
  // from before the change opens nothing.
  let epoch = 0;
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

  // A new thread is not in T3 Code's database before its first message, so
  // its project comes from the drafts T3 Code keeps in local storage. Any
  // other shape of them shows no section.
  let draftsRaw = null;
  let drafts = null;
  const draftEntry = () => {
    try {
      const segments = routeKey(location.href).split("/");
      if (segments[0] !== "draft" || !segments[1]) return null;
      const draftId = decodeURIComponent(segments[1]);
      // The drafts hold every unsent prompt, so they are parsed only when
      // they change.
      const raw = localStorage.getItem(draftsKey);
      if (raw !== draftsRaw) {
        draftsRaw = raw;
        drafts = null;
        drafts = JSON.parse(raw || "null");
      }
      const threads = drafts && drafts.state && drafts.state.draftThreadsByThreadKey;
      const draft = threads && Object.hasOwn(threads, draftId) ? threads[draftId] : null;
      return draft && typeof draft === "object" ? draft : null;
    } catch {
      return null;
    }
  };
  const draftProject = () => {
    const draft = draftEntry();
    return draft && typeof draft.projectId === "string" && draft.projectId ? draft.projectId : null;
  };
  // T3 Code names a thread by its environment and its id. A new thread has
  // both in its draft.
  const threadRef = () => {
    const named = (environmentId, threadId) =>
      typeof environmentId === "string" && environmentId && typeof threadId === "string" && threadId
        ? { environmentId, threadId }
        : null;
    const segments = routeKey(location.href).split("/");
    if (segments.length !== 2) return null;
    if (segments[0] === "draft") {
      const draft = draftEntry();
      return draft ? named(draft.environmentId, draft.threadId) : null;
    }
    try {
      return named(decodeURIComponent(segments[0]), decodeURIComponent(segments[1]));
    } catch {
      return null;
    }
  };
  // Set when the timers start.
  let lastProject = null;
  const request = (reason) => {
    if (enabled) notify({ type: "check", path: location.href, project: draftProject(), reason });
  };
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
  // GitHub is set only as text. Its items and "more" lines are links, which
  // the launcher opens in the browser.
  let tip = null;
  let tipAnchor = null;
  let showTimer = 0;
  let hideTimer = 0;
  let tipHiddenAt = 0;
  // The repository of the row whose tooltip is shown. A row keeps the one it
  // was built for, even after newer counts arrive and before it is replaced.
  let tipRepo = "";
  // Set while focus returns to a row, so its tooltip does not open again.
  let returning = false;
  // A press on an item, which can start a drag, moves the focus to it. The
  // focus from before the press, such as the composer, returns after the
  // click or the drag.
  let pressFocus = null;
  let dragging = false;
  let restoring = false;

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

  const shortAgo = (time) => {
    if (typeof time !== "number" || !Number.isFinite(time)) return "";
    const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
    if (minutes < 1) return "now";
    if (minutes < 60) return minutes + "m";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h";
    return Math.floor(hours / 24) + "d";
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

  const linkTo = (node, link) => {
    node.href = link.startsWith("https://") ? link : "https://github.com/" + tipRepo + "/" + link;
    node.dataset.link = link;
    node.dataset.repo = tipRepo;
    // The arrow keys move between the links, so Tab skips them.
    node.tabIndex = -1;
  };

  const rowTones = {
    "issue-open": "text-emerald-600 dark:text-emerald-300/90",
    "pull-open": "text-emerald-600 dark:text-emerald-300/90",
    "pull-draft": "text-zinc-500 dark:text-zinc-400/80",
  };
  const githubMark = () => {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "t3-rtl-row-provider");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "GitHub");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", ${JSON.stringify(GITHUB_MARK)});
    path.setAttribute("fill", "currentColor");
    path.setAttribute("fill-rule", "evenodd");
    svg.appendChild(path);
    return svg;
  };
  const rowAgo = (time) => {
    const short = shortAgo(time);
    return short === "now" ? "just now" : short && short + " ago";
  };

  const rowParts = (item) => {
    const state = icon(item.row.icon);
    state.setAttribute("class", "t3-rtl-row-state lucide " + rowTones[item.row.icon]);
    const first = make("span", "t3-rtl-row-line");
    first.appendChild(make("span", "t3-rtl-row-number", item.lead));
    const title = make("span", "t3-rtl-row-title", item.text);
    title.dir = "auto";
    first.appendChild(title);
    const second = make("span", "t3-rtl-row-meta");
    if (item.row.author) {
      const named = make("span", "t3-rtl-row-actor");
      if (item.row.avatar) {
        const image = document.createElement("img");
        image.setAttribute("aria-hidden", "true");
        image.alt = "";
        image.loading = "lazy";
        image.draggable = false;
        image.className = "t3-rtl-row-avatar";
        image.src = item.row.avatar;
        named.appendChild(image);
      }
      named.appendChild(make("span", "t3-rtl-row-author", item.row.author));
      second.appendChild(named);
    }
    second.appendChild(githubMark());
    second.appendChild(make("span", "t3-rtl-row-repo", tipRepo));
    for (const data of item.badges) second.appendChild(badge(data));
    const when = rowAgo(item.time);
    if (when) second.appendChild(make("span", "t3-rtl-row-time", when));
    const body = make("span", "t3-rtl-row-body");
    body.append(first, second);
    return [state, body];
  };

  const tipItem = (item) => {
    const githubLinked = typeof item.link === "string" && item.link !== "";
    const target = githubLinked ? item.link : typeof item.url === "string" && item.url.startsWith("https://") ? item.url : "";
    const linked = target !== "";
    const node = make(linked ? "a" : "div", "t3-rtl-tip-item");
    if (linked) linkTo(node, target);
    node.draggable = true;
    node.tabIndex = -1;
    node.dataset.quote = [item.lead, item.text, githubLinked ? node.href : ""]
      .map((part) => (part == null ? "" : String(part).trim()))
      .filter(Boolean)
      .join(" ");
    const pull = item.pull;
    if (githubLinked && pull && Number.isInteger(pull.number) && typeof pull.headBranch === "string" && typeof pull.baseBranch === "string") {
      node.dataset.pull = JSON.stringify({
        number: pull.number,
        title: String(pull.title).slice(0, 2048),
        url: node.href,
        headBranch: pull.headBranch,
        baseBranch: pull.baseBranch,
        state: "open",
        isDraft: pull.isDraft === true,
      });
    }
    if (item.row) {
      node.dataset.row = "";
      node.append(...rowParts(item));
      return node;
    }
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

  // T3 Code opens a pull request link in a message in the thread's panel when
  // its "Open pull requests in T3 Code" setting is on, and an issue link
  // there whenever its server can show issues. A pull request or an issue in
  // a tooltip opens the same way, through the store of that panel. T3 Code
  // has no public way to do this, so any doubt opens GitHub instead.
  let panelStore = null;
  const panelStoreUrls = async () => {
    const urls = new Set();
    const file = /\\/rightPanelStore-[\\w-]+\\.js$/;
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        if (file.test(new URL(entry.name).pathname)) urls.add(entry.name);
      }
    } catch {}
    if (urls.size) return [...urls];
    // The entry script lists the chunks that the app loads at start.
    for (const script of document.querySelectorAll("script[type=module][src]")) {
      try {
        const match = /rightPanelStore-[\\w-]+\\.js/.exec(await (await fetch(script.src)).text());
        if (match) urls.add(new URL(match[0], script.src).href);
      } catch {}
    }
    return [...urls];
  };
  // The address is the one the app loaded, so the import gives the store
  // that the app uses rather than a second copy.
  const findPanelStore = async () => {
    if (panelStore) return panelStore;
    for (const url of await panelStoreUrls()) {
      try {
        const module = await import(url);
        for (const value of Object.values(module)) {
          const state = value && typeof value.getState === "function" ? value.getState() : null;
          if (state && typeof state.openPullRequest === "function" && state.byThreadKey && typeof state.byThreadKey === "object") {
            panelStore = value;
            return value;
          }
        }
      } catch {}
    }
    return null;
  };
  // T3 Code turns the setting on unless it was turned off. Without a saved
  // settings file the bridge answers null, which means the defaults. Any
  // other answer, or none, is a doubt, so it opens GitHub.
  const opensPullRequestsInApp = async () => {
    try {
      const settings = await window.desktopBridge.getClientSettings();
      if (settings === null) return true;
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
      const value = settings.pullRequestLinksOpenInApp;
      return value === undefined || value === true;
    } catch {
      return false;
    }
  };
  const within = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
  const pullLink = /^pull\\/([1-9][0-9]{0,9})$/;
  const issueLink = /^issues\\/([1-9][0-9]{0,9})$/;
  const threadKey = (thread) => (thread ? thread.environmentId + ":" + thread.threadId : null);
  // T3 Code's link parser writes each part of the repository this way.
  const repositoryName = (repo) => repo.split("/").map((part) => {
    try {
      return encodeURIComponent(decodeURIComponent(part).toLowerCase()).toLowerCase();
    } catch {
      return part.toLowerCase();
    }
  }).join("/");
  // The rows that the clicked link belongs to are still the ones shown, on
  // the same thread.
  const stillShown = (repo, projectId, key) =>
    !!current && current.repo === repo && current.projectId === projectId &&
    routeKey(current.path) === routeKey(location.href) && threadKey(threadRef()) === key;
  // Resolves to true when the panel shows, to null when the page moved
  // away first, and to false otherwise.
  const panelShown = (moved) => new Promise((resolve) => {
    const deadline = Date.now() + 2000;
    const check = () => {
      const content = document.querySelector("[data-right-panel-surface-content]");
      if (moved()) resolve(null);
      else if (content && content.getClientRects().length > 0) resolve(true);
      else if (Date.now() > deadline) resolve(false);
      else setTimeout(check, 100);
    };
    check();
  });
  // What a link opens in the panel: the store action, the fields of T3 Code's
  // own link, so both open one tab, and whether the active tab is that one.
  const panelTarget = (link, repo, projectId) => {
    const url = "https://github.com/" + repo + "/" + link;
    const pull = pullLink.exec(link);
    if (pull) {
      const number = Number(pull[1]);
      const repository = repositoryName(repo);
      return {
        action: "openPullRequest",
        allowed: opensPullRequestsInApp,
        surface: { projectId, host: "github.com", repository, number, url },
        matches: (active) => active.kind === "pull-request" && active.projectId === projectId &&
          active.host === "github.com" && active.repository === repository && active.number === number,
      };
    }
    const issue = issueLink.exec(link);
    if (!issue) return null;
    // T3 Code's GitHub issue link names the repository in lower case and
    // the issue by its number as text.
    const scope = repo.toLowerCase();
    const key = issue[1];
    return {
      action: "openIssue",
      // T3 Code has no setting for issues. A store with this action belongs
      // to a T3 Code whose server shows issues.
      allowed: async () => true,
      surface: { projectId, tracker: "github", host: "github.com", scope, key, url },
      matches: (active) => active.kind === "issue" && active.projectId === projectId && active.tracker === "github" &&
        active.host === "github.com" && typeof active.scope === "string" && active.scope.toLowerCase() === scope &&
        active.key === key,
    };
  };
  // Resolves to whether the pull request or the issue opened in T3 Code's
  // panel, or to null when it should open nowhere. The thread and the
  // project are those of the click.
  const openInApp = async (link, repo, thread, projectId, clickEpoch) => {
    const target = panelTarget(link, repo, projectId);
    const key = threadKey(thread);
    const moved = () => epoch !== clickEpoch || !stillShown(repo, projectId, key);
    if (moved()) return null;
    if (!target) return false;
    const found = await within((async () => ((await target.allowed()) ? findPanelStore() : null))(), 2000);
    // A page that moved to another thread or repository meanwhile opens
    // nothing, so the click does not reach the thread left behind.
    if (moved()) return null;
    const store = found && typeof found.getState().byThreadKey === "object" &&
      typeof found.getState()[target.action] === "function" ? found : null;
    if (!store) return false;
    let before;
    let after;
    // Takes back this click's change, unless the panel changed since.
    const undo = () => {
      try {
        if (after === before || store.getState().byThreadKey[key] !== after || typeof store.setState !== "function") return;
        store.setState((state) => {
          const byThreadKey = { ...state.byThreadKey };
          if (before === undefined) delete byThreadKey[key];
          else byThreadKey[key] = before;
          return { byThreadKey };
        });
      } catch {}
    };
    try {
      before = store.getState().byThreadKey[key];
      store.getState()[target.action](thread, target.surface);
      after = store.getState().byThreadKey[key];
      const surfaces = after && after.isOpen && Array.isArray(after.surfaces) ? after.surfaces : [];
      const active = surfaces.find((item) => item && item.id === after.activeSurfaceId);
      if (!active || !target.matches(active)) {
        undo();
        return false;
      }
    } catch {
      // The store may have changed before it failed, such as on a full
      // local storage.
      try {
        after = store.getState().byThreadKey[key];
      } catch {}
      undo();
      return false;
    }
    const shown = await panelShown(moved);
    // A section turned off meanwhile takes back this click's change, so the
    // panel does not show the item later.
    if (shown === null && epoch !== clickEpoch) {
      undo();
      return null;
    }
    // The item waits in the panel of the thread left behind.
    if (shown !== false) return shown;
    undo();
    return false;
  };
  // One item opens at a time, so a click that gives up takes back only its
  // own change.
  let opening = Promise.resolve();
  const openLink = (link, repo, external) => {
    const browser = () => notify({ type: "open", link, repo });
    const thread = threadRef();
    const projectId = current && typeof current.projectId === "string" ? current.projectId : "";
    const inApp = pullLink.test(link || "") || issueLink.test(link || "");
    if (external || !inApp || !projectId || !stillShown(repo, projectId, threadKey(thread))) {
      browser();
      return;
    }
    const clickEpoch = epoch;
    const fallback = () => {
      if (epoch === clickEpoch && enabled) browser();
    };
    opening = opening
      .then(() => (epoch === clickEpoch ? openInApp(link, repo, thread, projectId, clickEpoch) : null))
      .then((opened) => {
        if (opened === false) fallback();
      }, fallback);
  };

  const tipLinks = () => (tip && tipAnchor ? Array.from(tip.querySelectorAll("[data-quote], a[data-link]")) : []);

  const focusLink = (index) => {
    const links = tipLinks();
    if (!links.length) return false;
    links[((index % links.length) + links.length) % links.length].focus();
    return true;
  };

  const ensureTip = () => {
    if (tip && tip.isConnected) return tip;
    tip = make("div", tipClass);
    tip.id = tipClass;
    // It holds links, so it is a small dialog rather than a tooltip.
    tip.setAttribute("role", "dialog");
    if (typeof tip.showPopover === "function") tip.setAttribute("popover", "manual");
    tip.addEventListener("pointerenter", () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    });
    tip.addEventListener("pointerleave", scheduleHide);
    // A press keeps the focus where it was, such as the composer, except on
    // an item, where the press may start a drag.
    tip.addEventListener("mousedown", (event) => {
      const item = event.button === 0 && event.target.closest && event.target.closest("[data-quote]");
      if (!item) {
        event.preventDefault();
        return;
      }
      const active = document.activeElement;
      pressFocus = active && active !== document.body && !tip.contains(active) ? active : null;
    });
    const activate = (event) => {
      const link = event.target.closest && event.target.closest("a[data-link]");
      if (!link || !tip.contains(link)) {
        if (event.type === "click" && event.detail > 0) restorePress();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "auxclick" && event.button !== 1) return;
      // As with T3 Code's own links, Ctrl, Cmd, or the middle button opens
      // GitHub in the browser.
      openLink(link.dataset.link, link.dataset.repo, event.ctrlKey || event.metaKey || event.button === 1);
      if (event.detail > 0) {
        const anchor = tipAnchor;
        hideTip();
        restorePress(anchor);
      } else if (tip.contains(document.activeElement)) {
        returnFocus();
      } else {
        hideTip();
      }
    };
    tip.addEventListener("contextmenu", (event) => event.stopPropagation());
    tip.addEventListener("click", activate);
    tip.addEventListener("auxclick", activate);
    // The quote goes as plain text, so the composer inserts it as typed. A
    // pull request also goes as T3 Code's pull request reference, which the
    // composer shows as a reference to that pull request.
    tip.addEventListener("dragstart", (event) => {
      const item = event.target.closest && event.target.closest("[data-quote]");
      if (!item || !tip.contains(item) || !event.dataTransfer) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.clearData();
      event.dataTransfer.setData("text/plain", item.dataset.quote);
      if (item.dataset.pull) event.dataTransfer.setData(PULL_REQUEST_TYPE, item.dataset.pull);
      // T3 Code's composer takes its pull request references as a move, and
      // a drag that allows only a copy would end without a drop there.
      event.dataTransfer.effectAllowed = item.dataset.pull ? "copyMove" : "copy";
      dragging = true;
      clearTimeout(hideTimer);
    });
    tip.addEventListener("dragend", () => {
      dragging = false;
      const anchor = tipAnchor;
      hideTip();
      // Counts that arrived during the drag show now.
      scheduleRender();
      // A drop elsewhere takes the focus there. A cancelled drag returns it.
      const active = document.activeElement;
      if (!active || active === document.body || tip.contains(active)) restorePress(anchor);
      else pressFocus = null;
    });
    tip.addEventListener("keydown", (event) => {
      const links = tipLinks();
      const index = links.indexOf(document.activeElement);
      if (index === -1) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        focusLink(index + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        event.stopPropagation();
        focusLink(event.key === "Home" ? 0 : -1);
      } else if (event.key === "Tab") {
        // The browser then moves on from the row, as if the tooltip had
        // not been entered.
        returnFocus();
      }
    });
    tip.addEventListener("focusout", (event) => {
      if (restoring) return;
      if (!tip.contains(event.relatedTarget) && event.relatedTarget !== tipAnchor) hideTip();
    });
    document.body.appendChild(tip);
    return tip;
  };

  const fillTip = (detail) => {
    const box = ensureTip();
    box.replaceChildren();
    box.setAttribute("aria-label", detail.title || "");
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
      // The last line opens the whole list when GitHub has a page for it.
      const count = (section.items || []).length;
      if (section.more > 0 || (section.link && (section.partial || count > listLineMin))) {
        const text = section.more > 0
          ? "and " + section.more + " more"
          : section.partial ? "View all on GitHub" : "View all " + count + " on GitHub";
        const line = make(section.link ? "a" : "div", "t3-rtl-tip-more", text);
        if (section.link) linkTo(line, section.link);
        part.appendChild(line);
      }
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
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (!anchor.isConnected || !detail || dragging) return;
    if (tipAnchor && tipAnchor !== anchor) tipAnchor.removeAttribute("aria-describedby");
    tipRepo = anchor.dataset.repo;
    fillTip(detail);
    tipAnchor = anchor;
    tip.setAttribute("data-open", "");
    // In the top layer it still shows above the card and everything else.
    const card = anchor.closest("[data-thread-details-card]") || document.body;
    if (tip.parentElement !== card) card.prepend(tip);
    if (tip.hasAttribute("popover") && !popoverOpen(tip)) {
      try {
        tip.showPopover();
      } catch {
        // A fixed tooltip with a high z-index still shows.
      }
    }
    // Beside the row the whole window height is free. Below or above it, only
    // the larger space is, so the tooltip, which takes clicks, never covers
    // its row. The sides match placeTip.
    const room = anchor.getBoundingClientRect();
    const width = tip.offsetWidth;
    const beside = room.left - 16 - width >= 0 || room.right + 16 + width <= innerWidth;
    tip.style.maxHeight = beside ? "" : Math.max(0, Math.max(room.top, innerHeight - room.bottom) - 16) + "px";
    // In a short window the tooltip scrolls, so every item stays in reach.
    tip.style.overflowY = tip.scrollHeight > tip.clientHeight ? "auto" : "";
    placeTip();
    anchor.setAttribute("aria-describedby", tip.id);
    requestAnimationFrame(() => {
      if (tipAnchor === anchor) tip.setAttribute("data-shown", "");
    });
  };

  const hideTip = () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    if (!tipAnchor) return;
    tipAnchor.removeAttribute("aria-describedby");
    tipAnchor = null;
    tipHiddenAt = Date.now();
    tip.removeAttribute("data-shown");
    tip.removeAttribute("data-open");
    if (popoverOpen(tip)) tip.hidePopover();
  };

  // Returns the focus from before a press in the tooltip, or leaves it
  // nowhere rather than on a hidden link.
  function restorePress(anchor = tipAnchor) {
    const target = pressFocus && pressFocus.isConnected ? pressFocus : anchor;
    pressFocus = null;
    // The tooltip stays open under the pointer.
    restoring = true;
    try {
      if (target && target.isConnected) target.focus({ preventScroll: true });
      else if (tip && tip.contains(document.activeElement)) document.activeElement.blur();
    } finally {
      restoring = false;
    }
  }

  // Closes the tooltip and moves the focus from its links back to the row.
  const returnFocus = () => {
    const anchor = tipAnchor;
    hideTip();
    if (!anchor || !anchor.isConnected) return;
    returning = true;
    try {
      anchor.focus();
    } finally {
      returning = false;
    }
  };

  // A pointer that leaves the row has a moment to reach the tooltip. While
  // a tooltip is open, another row takes it over only after the pointer
  // rests there, so a pointer on its way into the tooltip can cross a row.
  const scheduleTip = (anchor, detail) => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    // Keyboard focus on a link keeps its tooltip on its row.
    if (tipAnchor === anchor || (tip && tip.contains(document.activeElement))) return;
    const delay = tipAnchor ? tipSwitchDelay : Date.now() - tipHiddenAt < 300 ? 0 : tipDelay;
    showTimer = setTimeout(() => showTip(anchor, detail), delay);
  };

  function scheduleHide() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    // A drag out of the tooltip keeps it open until the drop.
    if (!tipAnchor || dragging) return;
    hideTimer = setTimeout(() => {
      // Keyboard focus on a link keeps the tooltip open.
      if (dragging || (tip && tip.contains(document.activeElement))) return;
      hideTip();
    }, tipHideDelay);
  }

  const attachTip = (element, detail) => {
    element.addEventListener("pointerenter", () => scheduleTip(element, detail));
    element.addEventListener("pointerleave", scheduleHide);
    element.addEventListener("focus", () => {
      if (!returning && element.matches(":focus-visible")) showTip(element, detail);
    });
    element.addEventListener("blur", (event) => {
      // Only the row's own tooltip closes, and focus that moves to a link
      // in it keeps it open.
      if (tipAnchor !== element || (tip && tip.contains(event.relatedTarget))) return;
      hideTip();
    });
    element.addEventListener("click", hideTip);
    // The Down arrow moves from the row to the first link in its tooltip.
    element.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (tipAnchor !== element) showTip(element, detail);
      if (focusLink(0)) event.preventDefault();
    });
  };

  // Closing the tooltip while a link has the focus returns it to the row.
  const closeTip = () => {
    // A drag ends on its own, and the scrolling it causes keeps the tooltip.
    if (dragging) return;
    if (tip && tip.contains(document.activeElement)) returnFocus();
    else hideTip();
  };

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // Escape closes the tooltip only, not the card or a panel around it.
    if (!tipAnchor) return;
    event.stopImmediatePropagation();
    closeTip();
  }, true);
  window.addEventListener("scroll", (event) => {
    if (!(tip && tip.contains(event.target))) closeTip();
  }, true);
  window.addEventListener("resize", closeTip);

  // The card holds a scroll area around one element with its sections. The
  // section goes after the last of them.
  const sectionContainer = (card) => {
    let node = card.querySelector('[data-slot="scroll-area-viewport"]') || card;
    const start = node;
    for (let depth = 0; node && depth < 8; depth += 1) {
      const children = Array.from(node.children).filter((child) => !child.hasAttribute(attribute) && !child.classList.contains(tipClass));
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
      const linked = linkKinds.includes(row.kind) || (typeof row.link === "string" && row.link !== "");
      const element = document.createElement(linked ? "button" : "div");
      element.className = "t3-rtl-repo-status-row";
      if (linked) element.type = "button";
      element.dataset.kind = row.kind;
      element.dataset.key = row.key || row.kind;
      element.dataset.repo = data.repo || "";
      if (row.tone) element.dataset.tone = row.tone;
      element.appendChild(icon(row.kind));
      const label = document.createElement("span");
      label.className = "t3-rtl-repo-status-label";
      label.textContent = row.label;
      element.appendChild(label);
      if (typeof row.time === "number") {
        const age = document.createElement("span");
        age.className = "t3-rtl-repo-status-age";
        age.dataset.time = String(row.time);
        age.textContent = shortAgo(row.time);
        element.appendChild(age);
      }
      const count = document.createElement("span");
      count.className = "t3-rtl-repo-status-count";
      count.textContent = row.count;
      element.appendChild(count);
      if (row.detail) {
        // The keyboard reaches a row that is not a button for its tooltip.
        if (!linked) element.tabIndex = 0;
        attachTip(element, row.detail);
      }
      if (linked) {
        element.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          notify({ type: "open", kind: row.kind, repo: data.repo, link: row.link });
        });
      }
      section.appendChild(element);
    }
    return section;
  };

  const render = () => {
    renderQueued = false;
    const focusedKey = tipAnchor && tip && tip.contains(document.activeElement) ? tipAnchor.dataset.key : null;
    const focusedCard = focusedKey ? tip.closest("[data-thread-details-card]") : null;
    if (current && current.project != null && current.project !== draftProject()) {
      current = null;
      request("navigate");
    }
    const rows = current && Array.isArray(current.rows) ? current.rows : [];
    const signature = rows.length ? currentSignature : "";
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
    for (const age of document.querySelectorAll("[" + attribute + "] .t3-rtl-repo-status-age")) {
      const text = shortAgo(Number(age.dataset.time));
      if (age.textContent !== text) age.textContent = text;
    }
    // A rebuilt or removed section takes the row of an open tooltip with it.
    if (tipAnchor && !tipAnchor.isConnected && !dragging) {
      hideTip();
      // The same row, or the first one when the refresh removed it.
      const scope = focusedCard && focusedCard.isConnected ? focusedCard : document;
      const row = focusedKey && (
        scope.querySelector("[" + attribute + "] [data-key=" + JSON.stringify(focusedKey) + "]") ||
        scope.querySelector("[" + attribute + "] button.t3-rtl-repo-status-row, [" + attribute + "] .t3-rtl-repo-status-row[tabindex]")
      );
      if (row) {
        returning = true;
        try {
          row.focus();
        } finally {
          returning = false;
        }
      }
    }
  };

  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  };

  window[receiver] = (data) => {
    if (!enabled) return false;
    if (!data || routeKey(data.path) !== routeKey(location.href)) return false;
    if ((data.project ?? null) !== draftProject()) return false;
    current = data;
    currentSignature = JSON.stringify([data.repo, data.rows]);
    scheduleRender();
    return true;
  };

  const observer = new MutationObserver(() => {
    if (current?.rows?.length || document.querySelector("[" + attribute + "]")) scheduleRender();
  });
  const startObserving = () => {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) startObserving();
  else document.addEventListener("DOMContentLoaded", startObserving, { once: true });

  // The timers run only while the section is on, so a page with it off
  // reads nothing, not even T3 Code's drafts.
  let timers = [];
  const watchAddress = () => {
    const project = draftProject();
    const otherProject = !!current && (current.project ?? null) !== project;
    if (location.href === lastHref && project === lastProject && !otherProject) return;
    // A new thread whose project changed shows another repository.
    const threadChanged = routeKey(location.href) !== routeKey(lastHref) || project !== lastProject || otherProject;
    lastHref = location.href;
    lastProject = project;
    if (threadChanged) {
      current = null;
      scheduleRender();
    }
    request("navigate");
  };
  const startTimers = () => {
    if (timers.length) return;
    lastHref = location.href;
    lastProject = draftProject();
    timers = [
      setInterval(watchAddress, 1000),
      setInterval(() => {
        if (document.visibilityState === "visible") request("interval");
      }, refreshInterval),
    ];
  };
  const stopTimers = () => {
    timers.forEach(clearInterval);
    timers = [];
  };
  window.addEventListener("focus", () => request("focus"));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") request("focus");
  });
  Object.defineProperty(window, ${JSON.stringify(ENABLE)}, {
    value: (value) => {
      const next = value === true;
      if (next !== enabled) {
        enabled = next;
        epoch += 1;
        current = null;
        scheduleRender();
      }
      if (enabled) startTimers();
      else stopTimers();
      request("navigate");
    },
  });
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
  issueDetail,
  lookupProjectFolder,
  lookupThreadFolder,
  openExternal,
  opensSqliteReadOnly,
  parseGitHubRemote,
  parseThreadLocation,
  parseThreadPath,
  pullDetail,
  readIssues,
  readSeverity,
  repositoryUrl,
  runFile,
  securityDetail,
};

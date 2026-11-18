"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FRESH_MS,
  REFRESH_INTERVAL_MS,
  buildRepoStatusPageSource,
  buildRows,
  summarizeBranches,
  createRepoStatusService,
  fetchCounts,
  lookupProjectFolder,
  lookupThreadFolder,
  opensSqliteReadOnly,
  parseGitHubRemote,
  parseThreadLocation,
  repositoryUrl,
} = require("../src/repo-status");

const root = path.resolve(__dirname, "..");
const threadId = "a24aa4b1-2599-4a22-923b-6969760bc606";
const environmentId = "3f1bb30d-8beb-4dd1-af19-91c9b1b309d7";
const threadHref = `t3code://app/${environmentId}/${threadId}`;

function count(value, capped = false) {
  return { value, capped };
}

// The sections of a row's tooltip: title, item texts, and how many more.
function tipLists(row) {
  return row.detail.sections.map((section) => [section.title || "", section.items.map((item) => item.text), section.more]);
}

test("the thread is read from the page address", () => {
  assert.deepEqual(parseThreadLocation(threadHref), { environmentId, threadId });
  assert.deepEqual(parseThreadLocation(`${threadHref}?panel=diff`), { environmentId, threadId });
  assert.deepEqual(parseThreadLocation(`t3code://app/#/${environmentId}/${threadId}`), {
    environmentId,
    threadId,
  });
  assert.deepEqual(
    parseThreadLocation(`t3code://app/#/${environmentId}/mcp%3Alaunch%3A78de3208`),
    { environmentId, threadId: "mcp:launch:78de3208" },
  );
  assert.equal(parseThreadLocation(`t3code://app/${environmentId}/a%2Fb`), null);
  assert.equal(parseThreadLocation("t3code://app/"), null);
  assert.equal(parseThreadLocation("t3code://app/settings"), null);
  assert.equal(parseThreadLocation("t3code://app/a%20b/c"), null);
  assert.equal(parseThreadLocation("not a url"), null);
  // A new thread has a draft route until its first message.
  assert.deepEqual(parseThreadLocation("t3code://app/draft/5fa95862-beec"), { draftId: "5fa95862-beec" });
  assert.deepEqual(parseThreadLocation("t3code://app/#/draft/d1?x=1"), { draftId: "d1" });
  assert.equal(parseThreadLocation("t3code://app/draft/a%20b"), null);
});

test("only GitHub remotes name a repository", () => {
  for (const remote of [
    "https://github.com/ShlomiPorush/t3code-rtl-fix.git",
    "https://github.com/ShlomiPorush/t3code-rtl-fix",
    "https://token@github.com/ShlomiPorush/t3code-rtl-fix.git\n",
    "git@github.com:ShlomiPorush/t3code-rtl-fix.git",
    "ssh://git@github.com/ShlomiPorush/t3code-rtl-fix.git",
  ]) {
    assert.deepEqual(parseGitHubRemote(remote), {
      owner: "ShlomiPorush",
      name: "t3code-rtl-fix",
      slug: "ShlomiPorush/t3code-rtl-fix",
    }, remote);
  }
  assert.equal(parseGitHubRemote("https://gitlab.com/owner/repo.git"), null);
  assert.equal(parseGitHubRemote("https://github.com.evil.example/owner/repo"), null);
  assert.equal(parseGitHubRemote("https://github.com/owner/repo/extra"), null);
  assert.equal(parseGitHubRemote("https://github.com/owner/.."), null);
  assert.equal(parseGitHubRemote("https://github.com/own er/repo"), null);
  assert.equal(parseGitHubRemote(""), null);
});

test("links open only the three GitHub pages of the repository", () => {
  const repo = parseGitHubRemote("https://github.com/o/r");
  assert.equal(repositoryUrl(repo, "issues"), "https://github.com/o/r/issues");
  assert.equal(repositoryUrl(repo, "pulls"), "https://github.com/o/r/pulls");
  assert.equal(repositoryUrl(repo, "security"), "https://github.com/o/r/security");
  assert.equal(repositoryUrl(repo, "settings"), null);
  assert.equal(repositoryUrl(null, "issues"), null);
});

test("rows appear only for counts above zero", () => {
  assert.deepEqual(buildRows(null), []);
  assert.deepEqual(
    buildRows({
      issues: count(0),
      pulls: count(0),
      dependabot: count(0),
      codeScanning: null,
      secretScanning: null,
    }),
    [],
  );
  const rows = buildRows({
    issues: count(3),
    pulls: count(0),
    dependabot: count(2),
    codeScanning: count(100, true),
    secretScanning: count(0),
  });
  assert.deepEqual(rows.map((row) => [row.kind, row.count]), [
    ["issues", "3"],
    ["security", "102+"],
  ]);
  assert.deepEqual(rows[1].detail.sections.map((section) => section.title), [
    "Dependabot · 2",
    "Code scanning · 100+",
  ]);
  assert.equal(rows[1].detail.summary, "102+ open");
  assert.equal(rows[1].tone, "warning");
});

test("counts are read from a GraphQL answer that also carries errors", async () => {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (args[3] === "graphql") {
      return {
        error: Object.assign(new Error("exit 1"), { code: 1 }),
        stdout: JSON.stringify({
          data: {
            repository: {
              issues: { totalCount: 4 },
              pullRequests: { totalCount: 1 },
              vulnerabilityAlerts: null,
            },
          },
          errors: [{ message: "no permission" }],
        }),
        stderr: "",
      };
    }
    if (args[3].includes("code-scanning")) {
      return { error: new Error("404"), stdout: '{"message":"no analysis found"}', stderr: "" };
    }
    return { error: null, stdout: "[{},{}]", stderr: "" };
  };
  const { branches, ...status } = await fetchCounts(run, parseGitHubRemote("https://github.com/o/r"));
  // Without a folder and without branches in the answer, no branch row shows.
  assert.equal(branches.remote, null);
  assert.equal(branches.local, null);
  assert.deepEqual(status, {
    issues: { ...count(4), items: [] },
    pulls: { ...count(1), items: [] },
    dependabot: null,
    codeScanning: null,
    secretScanning: { ...count(2), alerts: [{ number: null, type: "" }, { number: null, type: "" }] },
  });
  assert.ok(calls.every(([file]) => file === "gh"));
  assert.ok(calls.every((call) => call[2] === "--hostname" && call[3] === "github.com"));
  assert.ok(calls.some((call) => call.includes("owner=o") && call.includes("name=r")));
});

test("a missing gh or an unreadable repository is an error", async () => {
  const repo = parseGitHubRemote("https://github.com/o/r");
  const missing = async () => ({
    error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }),
    stdout: "",
    stderr: "",
  });
  await assert.rejects(fetchCounts(missing, repo), /gh command was not found/);
  const refused = async () => ({
    error: new Error("exit 1"),
    stdout: '{"data":{"repository":null}}',
    stderr: "GraphQL: Could not resolve to a Repository\n",
  });
  await assert.rejects(fetchCounts(refused, repo), /Could not resolve to a Repository/);
});

test("the database opens only on Node.js versions that honor readOnly", () => {
  for (const version of ["18.20.0", "20.18.0", "22.5.0", "22.11.0", "23.0.0", "23.1.0"]) {
    assert.equal(opensSqliteReadOnly(version), false, version);
  }
  for (const version of ["22.12.0", "23.2.0", "24.22.1", "25.0.0"]) {
    assert.equal(opensSqliteReadOnly(version), true, version);
  }
});

test("the thread folder comes from T3 Code's database", (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    t.skip("node:sqlite is unavailable in this Node.js");
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rtl-repo-status-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const create = (file, sql) => {
    const database = new DatabaseSync(path.join(directory, file));
    database.exec(sql);
    database.close();
  };

  assert.throws(() => lookupThreadFolder(directory, "t1"), /not found/);

  // Older T3 Code releases keep threads in state.sqlite.
  create("state.sqlite", `
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_path TEXT);
    INSERT INTO projection_projects VALUES ('p1', 'C:\\old-repo', NULL);
    INSERT INTO projection_threads VALUES ('t1', 'p1', NULL), ('t2', 'p1', 'C:\\old-worktree');
  `);
  assert.deepEqual(lookupThreadFolder(directory, "t1"), ["C:\\old-repo"]);
  assert.deepEqual(lookupThreadFolder(directory, "t2"), ["C:\\old-worktree", "C:\\old-repo"]);
  assert.deepEqual(lookupProjectFolder(directory, "p1"), ["C:\\old-repo"]);

  // Current releases write statev2.sqlite and leave state.sqlite behind.
  const payload = (id, worktreePath) => JSON.stringify({ id, worktreePath }).replace(/'/g, "''");
  create("statev2.sqlite", `
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL);
    INSERT INTO projection_projects VALUES ('p1', 'C:\\repo', NULL), ('p2', 'C:\\removed', '2026-01-01');
    INSERT INTO orchestration_v2_projection_threads VALUES
      ('t1', 'p1', '${payload("t1", null)}'),
      ('mcp:launch:78de3208', 'p1', '${payload("mcp:launch:78de3208", "C:\\worktree")}');
  `);
  assert.deepEqual(lookupThreadFolder(directory, "t1"), ["C:\\repo"]);
  assert.deepEqual(lookupThreadFolder(directory, "mcp:launch:78de3208"), ["C:\\worktree", "C:\\repo"]);
  assert.equal(lookupThreadFolder(directory, "t2"), null);
  // A new thread has only its project. A removed project has no folder.
  assert.deepEqual(lookupProjectFolder(directory, "p1"), ["C:\\repo"]);
  assert.equal(lookupProjectFolder(directory, "p2"), null);
  assert.equal(lookupProjectFolder(directory, "p3"), null);
});

function createHarness({ folder = "C:\\repo", remote = "https://github.com/o/r.git" } = {}) {
  const state = {
    time: 1_000_000,
    folder,
    graphqlCalls: 0,
    failGraphql: false,
    issues: 2,
    pushes: [],
    opened: [],
    logs: [],
    folderLookups: 0,
    remotes: {},
    projects: {},
    projectLookups: [],
    holdGit: false,
    holdGraphql: false,
    releases: [],
    sent: [],
    localBranches: "",
    refs: null,
  };
  const hold = () => new Promise((resolve) => state.releases.push(resolve));
  const run = async (file, args) => {
    if (file === "git") {
      if (args[1] === "C:\\gone") return { error: new Error("not a git repository"), stdout: "", stderr: "fatal" };
      if (args[2] === "for-each-ref") return { error: null, stdout: state.localBranches, stderr: "" };
      if (state.holdGit) await hold();
      return { error: null, stdout: `${state.remotes[args[1]] || remote}\n`, stderr: "" };
    }
    if (args[3] === "graphql") {
      state.graphqlCalls += 1;
      if (state.holdGraphql) await hold();
      if (state.failGraphql) return { error: new Error("offline"), stdout: "", stderr: "offline" };
      return {
        error: null,
        stdout: JSON.stringify({
          data: {
            repository: {
              issues: { totalCount: state.issues },
              pullRequests: { totalCount: 0 },
              vulnerabilityAlerts: { totalCount: 0 },
              defaultBranchRef: { name: "main" },
              refs: state.refs,
            },
          },
        }),
        stderr: "",
      };
    }
    return { error: null, stdout: "[]", stderr: "" };
  };
  const send = async (method, params, sessionId) => {
    state.sent.push([sessionId, method]);
    if (method !== "Runtime.evaluate" || !params.expression.includes("receive(")) return {};
    if (state.failPush) throw new Error("the page navigated");
    const match = /receive\((.*)\) === true;/.exec(params.expression);
    state.pushes.push({ sessionId, data: JSON.parse(match[1]) });
    // A page on another thread or project does not take the rows.
    return { result: { value: !state.rejectPush } };
  };
  const service = createRepoStatusService({
    send,
    run,
    log: (message) => state.logs.push(message),
    now: () => state.time,
    findThreadFolder: (id) => {
      state.folderLookups += 1;
      return typeof state.folder === "function" ? state.folder(id) : state.folder;
    },
    findProjectFolder: (id) => {
      state.projectLookups.push(id);
      return state.projects[id] || null;
    },
    open: async (url) => state.opened.push(url),
  });
  const check = (reason = "navigate", href = threadHref, project) =>
    service.handle("s1", JSON.stringify({ type: "check", path: href, reason, project }));
  const last = () => state.pushes.at(-1).data;
  return { service, state, check, last };
}

test("a check pushes the rows of the open thread's repository", async () => {
  const { check, last } = createHarness();
  await check();
  assert.equal(last().path, threadHref);
  assert.equal(last().repo, "o/r");
  assert.deepEqual(last().rows.map((row) => row.kind), ["issues"]);
});

test("counts are reused while fresh and refreshed by the interval", async () => {
  const { state, check } = createHarness();
  await check();
  state.time += FRESH_MS - 1;
  await check("focus");
  assert.equal(state.graphqlCalls, 1);
  state.time += 2;
  await check("focus");
  assert.equal(state.graphqlCalls, 2);
  state.time += REFRESH_INTERVAL_MS - 60 * 1000;
  await check("interval");
  assert.equal(state.graphqlCalls, 2);
  state.time += 60 * 1000;
  await check("interval");
  assert.equal(state.graphqlCalls, 3);
});

test("a failed refresh hides the section and logs the failure once", async () => {
  const { state, check, last } = createHarness();
  await check();
  assert.deepEqual(last().rows.map((row) => row.count), ["2"]);
  state.failGraphql = true;
  state.time += FRESH_MS + 1;
  await check("focus");
  assert.deepEqual(last().rows, []);
  state.time += FRESH_MS + 1;
  await check("focus");
  assert.deepEqual(last().rows, []);
  assert.equal(state.logs.filter((message) => message.includes("did not return")).length, 1);
  state.failGraphql = false;
  await check("focus");
  assert.deepEqual(last().rows.map((row) => row.count), ["2"]);
});

test("an interval check after a failure does not bring back old counts", async () => {
  const { state, check, last } = createHarness();
  await check();
  state.time += FRESH_MS + 1;
  state.failGraphql = true;
  await check("focus");
  assert.deepEqual(last().rows, []);
  // Younger than the interval's age limit, but older than the failure.
  state.time += 1;
  await check("interval");
  assert.deepEqual(last().rows, []);
  assert.equal(state.graphqlCalls, 3);
});

test("a row stays clickable while the same thread refreshes", async () => {
  const { service, state, check } = createHarness();
  await check();
  state.holdGraphql = true;
  state.time += FRESH_MS + 1;
  const refreshing = check("focus");
  await new Promise((resolve) => setImmediate(resolve));
  await service.handle("s1", JSON.stringify({ type: "open", repo: "o/r", kind: "issues" }));
  assert.deepEqual(state.opened, ["https://github.com/o/r/issues"]);
  state.releases.forEach((release) => release());
  await refreshing;
});

test("a check replaced by another thread does not query GitHub", async () => {
  const otherThread = "b24aa4b1-2599-4a22-923b-6969760bc606";
  const otherHref = `t3code://app/${environmentId}/${otherThread}`;
  const { state, check, last } = createHarness();
  state.folder = (id) => (id === threadId ? "C:\\repo" : null);
  state.holdGit = true;
  const stale = check();
  await new Promise((resolve) => setImmediate(resolve));
  state.holdGit = false;
  await check("navigate", otherHref);
  state.releases.forEach((release) => release());
  await stale;
  assert.equal(state.graphqlCalls, 0);
  assert.equal(state.pushes.length, 1);
  assert.equal(last().path, otherHref);
});

test("a reloaded page gets the binding again without the Runtime domain", async () => {
  const { service, state } = createHarness();
  await service.reattach("s1");
  assert.deepEqual(state.sent, []);
  await service.attach("s1");
  const methods = state.sent.map(([, method]) => method);
  assert.ok(methods.includes("Page.enable"));
  assert.ok(!methods.includes("Runtime.enable"));
  state.sent.length = 0;
  await service.reattach("s1");
  assert.deepEqual(state.sent.map(([, method]) => method), ["Runtime.addBinding", "Runtime.evaluate"]);
  service.forget("s1");
  state.sent.length = 0;
  await service.reattach("s1");
  assert.deepEqual(state.sent, []);
});

test("all-zero counts, a missing thread, and other remotes hide the section", async () => {
  const zero = createHarness();
  zero.state.issues = 0;
  await zero.check();
  assert.deepEqual(zero.last().rows, []);
  assert.equal(zero.last().repo, null);

  const unknown = createHarness({ folder: null });
  await unknown.check();
  assert.deepEqual(unknown.last().rows, []);
  // A thread that T3 Code has not written yet is looked up again.
  await unknown.check("focus");
  assert.equal(unknown.state.folderLookups, 2);

  const gitlab = createHarness({ remote: "https://gitlab.com/o/r.git" });
  await gitlab.check();
  assert.deepEqual(gitlab.last().rows, []);
  assert.equal(gitlab.state.graphqlCalls, 0);

  const settings = createHarness();
  await settings.check("navigate", "t3code://app/settings");
  assert.deepEqual(settings.last().rows, []);
  assert.equal(settings.state.folderLookups, 0);
});

const NOW = Date.parse("2026-11-17T12:00:00Z");
const daysAgo = (days) => NOW - days * 24 * 60 * 60 * 1000;

test("branches are sorted into remote, local, dead, and stale", () => {
  const summary = summarizeBranches(
    {
      defaultBranch: "main",
      remote: {
        total: 5,
        capped: false,
        nodes: [
          { name: "main", time: daysAgo(1), merged: false },
          { name: "feature/active", time: daysAgo(2), merged: false },
          { name: "feature/merged", time: daysAgo(3), merged: true },
          { name: "feature/old", time: daysAgo(45), merged: false },
          { name: "feature/old-remote-new-local", time: daysAgo(60), merged: false },
        ],
      },
      local: [
        { name: "main", upstream: "main", time: daysAgo(1) },
        { name: "feature/active", upstream: "feature/active", time: daysAgo(2) },
        { name: "feature/gone", upstream: "feature/gone", time: daysAgo(90) },
        { name: "spike", upstream: null, time: daysAgo(40) },
        { name: "feature/old-remote-new-local", upstream: "feature/old-remote-new-local", time: daysAgo(5) },
      ],
    },
    NOW,
  );
  assert.equal(summary.remote.value, 4);
  // Newest first.
  assert.deepEqual(
    summary.local.branches.map((branch) => [branch.name, branch.deleted]),
    [
      ["feature/active", false],
      ["feature/old-remote-new-local", false],
      ["spike", false],
      ["feature/gone", true],
    ],
  );
  assert.deepEqual(summary.dead.merged, [{ name: "feature/merged", time: daysAgo(3) }]);
  assert.deepEqual(summary.dead.deleted, [{ name: "feature/gone", time: daysAgo(90) }]);
  assert.equal(summary.dead.value, 2);
  // A dead branch is not also stale, and the newest copy of a branch decides.
  assert.deepEqual(summary.stale.branches, [
    { name: "feature/old", time: daysAgo(45), days: 45, github: true },
    { name: "spike", time: daysAgo(40), days: 40, github: false },
  ]);
});

test("a partial list of GitHub branches does not mark local branches as deleted", () => {
  const summary = summarizeBranches(
    {
      defaultBranch: "main",
      remote: { total: 250, capped: true, nodes: [{ name: "feature/a", time: daysAgo(1), merged: true }] },
      local: [{ name: "feature/not-in-page", upstream: "feature/not-in-page", time: daysAgo(1) }],
    },
    NOW,
  );
  assert.equal(summary.remote.value, 249);
  assert.deepEqual(summary.dead.deleted, []);
  assert.deepEqual(summary.dead.merged, [{ name: "feature/a", time: daysAgo(1) }]);
  assert.equal(summary.dead.capped, true);
  const rows = buildRows({ branches: summary });
  assert.equal(rows.find((row) => row.kind === "branches-dead").count, "1+");
  const remoteTip = rows.find((row) => row.kind === "branches-remote").detail;
  // One branch was read of 249, so the tooltip counts the rest and says why.
  assert.deepEqual(tipLists({ detail: remoteTip }), [["", ["feature/a"], 248]]);
  assert.equal(remoteTip.note, "Only the first 100 branches on GitHub were read.");
});

test("branch rows form one group with branches in their tooltips", () => {
  const rows = buildRows({
    issues: count(1),
    branches: {
      remote: {
        value: 120,
        capped: false,
        partial: false,
        branches: Array.from({ length: 120 }, (_, i) => ({ name: `b${i}`, time: daysAgo(i), merged: i === 0 })),
      },
      local: { value: 0, capped: false, branches: [] },
      dead: {
        value: 2,
        capped: false,
        merged: [{ name: "m1", time: daysAgo(3) }],
        deleted: [{ name: "d1", time: null }],
      },
      stale: { value: 1, capped: true, branches: [{ name: "old", time: daysAgo(40), days: 40 }] },
    },
  });
  assert.deepEqual(rows.map((row) => [row.group || "", row.kind, row.label, row.count]), [
    ["", "issues", "Issues", "1"],
    ["branches", "branches-remote", "Remote", "120"],
    ["branches", "branches-dead", "Dead", "2"],
    ["branches", "branches-stale", "Stale", "1+"],
  ]);
  // A tooltip lists up to 100 branches, and the line opens the rest.
  assert.deepEqual(tipLists(rows[1]), [["", Array.from({ length: 100 }, (_, i) => `b${i}`), 20]]);
  assert.deepEqual(rows[1].detail.sections[0].items[0], {
    text: "b0",
    time: daysAgo(0),
    link: "tree/b0",
    badges: [{ text: "Merged", tone: "success" }],
  });
  assert.equal(rows[1].detail.sections[0].link, "branches/all");
  assert.equal(rows[1].detail.note, undefined);
  assert.deepEqual(tipLists(rows[2]), [
    ["Merged on GitHub", ["m1"], 0],
    ["Deleted on GitHub", ["d1"], 0],
  ]);
  assert.deepEqual(tipLists(rows[3]), [["", ["old"], 0]]);
  assert.equal(rows[3].detail.summary, "No commits for 30+ days");
  assert.equal(rows[3].detail.note, "Some branches could not be checked, so there may be more.");
});

test("issue and pull request tooltips list the latest items with their state", () => {
  const rows = buildRows({
    issues: {
      value: 7,
      capped: false,
      items: [
        { number: 12, title: "כותרת בעברית", author: "dana", time: daysAgo(1), labels: [{ name: "bug", color: "d73a4a" }, { name: "x", color: null }] },
      ],
    },
    pulls: {
      value: 2,
      capped: false,
      items: [
        { number: 58, title: "Branches", author: "shlomi", time: daysAgo(0), draft: false, review: "APPROVED" },
        { number: 49, title: "Tables", author: "", time: null, draft: true, review: null },
      ],
    },
  });
  assert.deepEqual(rows[0].detail, {
    title: "Issues",
    summary: "7 open",
    sections: [
      {
        items: [
          {
            lead: "#12",
            text: "כותרת בעברית",
            meta: ["dana"],
            time: daysAgo(1),
            badges: [{ text: "bug", color: "d73a4a" }, { text: "x", color: null }],
            link: "issues/12",
          },
        ],
        more: 6,
        link: "issues",
      },
    ],
  });
  assert.deepEqual(
    rows[1].detail.sections[0].items.map((item) => [item.lead, item.meta, item.badges]),
    [
      ["#58", ["shlomi"], [{ text: "Approved", tone: "success" }]],
      ["#49", [], [{ text: "Draft", tone: "muted" }]],
    ],
  );
});

test("the security tooltip groups alerts by source and severity", () => {
  const [row] = buildRows({
    dependabot: {
      value: 150,
      capped: false,
      alerts: [
        { severity: "low", package: "a" },
        { severity: "critical", package: "b" },
        { severity: "high", package: "c" },
        { severity: "critical", package: "d" },
      ],
    },
    codeScanning: { value: 1, capped: false, alerts: [{ severity: "medium", rule: "XSS", path: "src/x.js" }] },
    secretScanning: { value: 1, capped: false, alerts: [{ type: "GitHub Token" }] },
  });
  const [dependabot, codeScanning, secretScanning] = row.detail.sections;
  assert.equal(row.count, "152");
  assert.deepEqual(dependabot.chips.map((chip) => chip.text), ["2 Critical", "1 High", "1 Low"]);
  assert.deepEqual(dependabot.items.map((item) => item.text), ["b", "d", "c", "a"]);
  assert.equal(dependabot.more, 146);
  assert.deepEqual(codeScanning.items, [
    { text: "XSS", meta: ["src/x.js"], badges: [{ text: "Medium", tone: "medium" }] },
  ]);
  assert.deepEqual(secretScanning, {
    title: "Secret scanning · 1",
    items: [{ text: "GitHub Token" }],
    more: 0,
  });
  assert.equal(row.detail.note, "Severities count the first 4 Dependabot alerts.");
});

test("a local branch shows how it stands against its upstream", () => {
  const summary = summarizeBranches(
    {
      defaultBranch: "main",
      remote: {
        total: 3,
        capped: false,
        nodes: [
          { name: "main", time: daysAgo(1), merged: false },
          { name: "feature/a", time: daysAgo(1), merged: false },
          { name: "feature/b", time: daysAgo(1), merged: false },
        ],
      },
      local: [
        { name: "feature/a", upstream: "feature/a", time: daysAgo(1), track: "" },
        { name: "feature/b", upstream: "feature/b", time: daysAgo(2), track: "ahead 1, behind 2" },
        { name: "feature/c", upstream: "feature/c", time: daysAgo(3), track: "gone" },
        { name: "spike", upstream: null, time: daysAgo(4), track: "" },
        { name: "wt", upstream: "main", time: daysAgo(5), track: "ahead 3" },
        // Tracks a branch on a remote other than origin.
        { name: "fork", upstream: null, tracking: true, time: daysAgo(6), track: "ahead 2, behind 1" },
      ],
    },
    NOW,
  );
  const local = buildRows({ branches: summary }).find((row) => row.kind === "branches-local");
  assert.deepEqual(
    local.detail.sections[0].items.map((item) => [item.text, item.badges[0].text, item.badges[0].tone]),
    [
      ["feature/a", "Up to date", "success"],
      ["feature/b", "ahead 1, behind 2", "medium"],
      // The complete GitHub list shows that feature/c is gone.
      ["feature/c", "Deleted on GitHub", "critical"],
      ["spike", "No upstream", "muted"],
      ["wt", "ahead 3", "info"],
      ["fork", "ahead 2, behind 1", "medium"],
    ],
  );
});

test("GitHub details are read into plain fields, and a found secret is dropped", async () => {
  const run = async (file, args) => {
    if (args[3] === "graphql") {
      return {
        error: null,
        stdout: JSON.stringify({
          data: {
            repository: {
              issues: {
                totalCount: 1,
                nodes: [
                  {
                    number: 3,
                    title: "x".repeat(400),
                    updatedAt: "2026-11-16T12:00:00Z",
                    author: null,
                    labels: { nodes: [{ name: "bug", color: "D73A4A" }, { name: "evil", color: "red;background:url(x)" }] },
                  },
                  null,
                  { number: "4", title: "not a number" },
                ],
              },
              pullRequests: {
                totalCount: 1,
                nodes: [{ number: 9, title: "p", updatedAt: "bad", isDraft: true, reviewDecision: "SOMETHING_NEW", author: { login: "me" } }],
              },
              vulnerabilityAlerts: {
                totalCount: 2,
                nodes: [
                  { number: 5, securityVulnerability: { severity: "MODERATE", package: { name: "lodash" } } },
                  { number: -1, securityVulnerability: null },
                ],
              },
            },
          },
        }),
        stderr: "",
      };
    }
    if (args[3].includes("code-scanning")) {
      return {
        error: null,
        stdout: JSON.stringify([{ number: 8, rule: { severity: "error", description: "SQL injection" }, most_recent_instance: { location: { path: "db.js" } } }]),
        stderr: "",
      };
    }
    return {
      error: null,
      stdout: JSON.stringify([{ number: 3, secret_type: "token", secret_type_display_name: "GitHub Token", secret: "ghp_SECRETVALUE" }]),
      stderr: "",
    };
  };
  const status = await fetchCounts(run, parseGitHubRemote("https://github.com/o/r"));
  assert.deepEqual(status.issues.items, [
    {
      number: 3,
      title: "x".repeat(300),
      author: "",
      time: Date.parse("2026-11-16T12:00:00Z"),
      labels: [{ name: "bug", color: "d73a4a" }, { name: "evil", color: null }],
    },
  ]);
  assert.deepEqual(status.pulls.items, [{ number: 9, title: "p", author: "me", time: null, draft: true, review: null }]);
  assert.deepEqual(status.dependabot.alerts, [
    { number: 5, severity: "medium", package: "lodash" },
    { number: null, severity: null, package: "" },
  ]);
  assert.deepEqual(status.codeScanning.alerts, [{ number: 8, severity: "high", rule: "SQL injection", path: "db.js" }]);
  assert.deepEqual(status.secretScanning.alerts, [{ number: 3, type: "GitHub Token" }]);
  assert.equal(JSON.stringify(buildRows(status)).includes("ghp_SECRETVALUE"), false);
});

test("a check reads GitHub and local branches into the Branches group", async () => {
  const { service, state, check, last } = createHarness();
  state.time = NOW;
  state.refs = {
    totalCount: 4,
    nodes: [
      { name: "main", target: { oid: "a1", committedDate: new Date(daysAgo(1)).toISOString() }, associatedPullRequests: { totalCount: 0, nodes: [] } },
      { name: "feature/done", target: { oid: "b2", committedDate: new Date(daysAgo(2)).toISOString() }, associatedPullRequests: { totalCount: 1, nodes: [{ headRefOid: "b2" }] } },
      { name: "feature/reused", target: { oid: "c3", committedDate: new Date(daysAgo(2)).toISOString() }, associatedPullRequests: { totalCount: 1, nodes: [{ headRefOid: "old" }] } },
      // The second merged pull request holds the tip.
      { name: "feature/twice", target: { oid: "d4", committedDate: new Date(daysAgo(2)).toISOString() }, associatedPullRequests: { totalCount: 2, nodes: [{ headRefOid: "older" }, { headRefOid: "d4" }] } },
    ],
  };
  const seconds = (time) => Math.floor(time / 1000);
  state.localBranches = [
    `main\0origin\0refs/heads/main\0${seconds(daysAgo(1))}`,
    `feature/gone\0origin\0refs/heads/feature/gone\0${seconds(daysAgo(3))}`,
    `feature/mirror\0upstream\0refs/heads/feature/mirror\0${seconds(daysAgo(3))}`,
    // A custom fetch mapping does not change the name on GitHub.
    `work\0origin\0refs/heads/feature/reused\0${seconds(daysAgo(3))}`,
  ].join("\r\n") + "\r\n";
  await check();
  assert.deepEqual(last().rows.map((row) => [row.kind, row.count]), [
    ["issues", "2"],
    ["branches-remote", "3"],
    ["branches-local", "3"],
    ["branches-dead", "3"],
  ]);
  assert.deepEqual(tipLists(last().rows[3]), [
    ["Merged on GitHub", ["feature/done", "feature/twice"], 0],
    ["Deleted on GitHub", ["feature/gone"], 0],
  ]);
  // feature/mirror tracks a branch on another remote, so it has an upstream.
  assert.deepEqual(
    last().rows[2].detail.sections[0].items.map((item) => [item.text, item.badges[0].text]),
    [
      ["feature/gone", "Deleted on GitHub"],
      ["feature/mirror", "Up to date"],
      ["work", "Up to date"],
    ],
  );

  await service.handle("s1", JSON.stringify({ type: "open", repo: "o/r", kind: "branches-local" }));
  await service.handle("s1", JSON.stringify({ type: "open", repo: "o/r", kind: "branches-dead" }));
  await service.handle("s1", JSON.stringify({ type: "open", repo: "o/r", kind: "constructor" }));
  assert.deepEqual(state.opened, ["https://github.com/o/r/branches"]);
});

test("a branch GitHub could not resolve keeps the other rows", async () => {
  const { state, check, last } = createHarness();
  state.time = NOW;
  state.refs = { totalCount: 2, nodes: [null, { name: "feature/a", target: null, associatedPullRequests: null }] };
  state.localBranches = `feature/maybe-gone\0origin\0refs/heads/feature/maybe-gone\0${Math.floor(daysAgo(1) / 1000)}\n`;
  await check();
  // The list is incomplete, so the local branch is not marked deleted.
  assert.deepEqual(last().rows.map((row) => row.kind), ["issues", "branches-remote", "branches-local"]);

  const broken = createHarness();
  broken.state.refs = { totalCount: 1, nodes: "not a list" };
  await broken.check();
  assert.deepEqual(broken.last().rows.map((row) => row.kind), ["issues"]);
});

test("two clones of one repository keep their own local branches", async () => {
  const { state, check, last } = createHarness();
  state.folder = (id) => (id === threadId ? "C:\\clone-a" : "C:\\clone-b");
  const otherHref = `t3code://app/${environmentId}/other-thread`;
  state.localBranches = `only-in-a\0\0\0${Math.floor(state.time / 1000)}\n`;
  await check();
  assert.deepEqual(tipLists(last().rows.find((row) => row.kind === "branches-local")), [["", ["only-in-a"], 0]]);
  state.localBranches = `only-in-b\0\0\0${Math.floor(state.time / 1000)}\n`;
  await check("navigate", otherHref);
  assert.deepEqual(tipLists(last().rows.find((row) => row.kind === "branches-local")), [["", ["only-in-b"], 0]]);
});

test("staleness follows the tracked GitHub branch, not the local name", () => {
  const summary = summarizeBranches(
    {
      defaultBranch: "main",
      remote: {
        total: 3,
        capped: false,
        nodes: [
          { name: "main", time: daysAgo(1), merged: false },
          { name: "feature/x", time: daysAgo(40), merged: false },
          { name: "shared-name", time: daysAgo(2), merged: false },
        ],
      },
      local: [
        // Tracks feature/x and has a recent commit, so feature/x is in use.
        { name: "work", upstream: "feature/x", time: daysAgo(1) },
        // Shares a name with a GitHub branch but tracks nothing.
        { name: "shared-name", upstream: null, time: daysAgo(50) },
        // Tracks the default branch, so it is stale under its own name.
        { name: "worktree-agent-1", upstream: "main", time: daysAgo(61) },
      ],
    },
    NOW,
  );
  assert.deepEqual(summary.stale.branches, [
    { name: "worktree-agent-1", time: daysAgo(61), days: 61, github: false },
    { name: "shared-name", time: daysAgo(50), days: 50, github: false },
  ]);
});

test("an unknown merge state or a branch outside the list is neither dead nor stale", async () => {
  const { state, check, last } = createHarness();
  state.time = NOW;
  const old = new Date(daysAgo(60)).toISOString();
  state.refs = {
    // Two of three branches, so the list is partial.
    totalCount: 3,
    nodes: [
      { name: "main", target: { oid: "a1", committedDate: old }, associatedPullRequests: { totalCount: 0, nodes: [] } },
      // Twelve merged pull requests, ten read, none holds the tip.
      {
        name: "feature/busy",
        target: { oid: "tip", committedDate: old },
        associatedPullRequests: { totalCount: 12, nodes: Array.from({ length: 10 }, (_, i) => ({ headRefOid: `old${i}` })) },
      },
    ],
  };
  // Tracks a GitHub branch that is not in the partial list.
  state.localBranches = `elsewhere\0origin\0refs/heads/feature/elsewhere\0${Math.floor(daysAgo(45) / 1000)}\n`;
  await check();
  const rows = Object.fromEntries(last().rows.map((row) => [row.kind, row.count]));
  assert.equal(rows["branches-dead"], undefined);
  assert.equal(rows["branches-stale"], undefined);
  assert.equal(rows["branches-remote"], "2");
  assert.equal(rows["branches-local"], "1");

  // With one stale branch shown, the count says that more may exist.
  const summary = summarizeBranches(
    {
      defaultBranch: "main",
      remote: {
        total: 2,
        capped: false,
        nodes: [
          { name: "feature/unknown", time: daysAgo(60), merged: null },
          { name: "feature/old", time: daysAgo(40), merged: false },
        ],
      },
      local: [],
    },
    NOW,
  );
  assert.deepEqual(summary.stale.branches, [{ name: "feature/old", time: daysAgo(40), days: 40, github: true }]);
  assert.equal(buildRows({ branches: summary }).find((row) => row.kind === "branches-stale").count, "1+");
});

test("an unreadable pull request or a missing GitHub list marks the counts as partial", async () => {
  const { state, check, last } = createHarness();
  state.time = NOW;
  const old = new Date(daysAgo(45)).toISOString();
  state.refs = {
    totalCount: 2,
    nodes: [
      { name: "main", target: { oid: "a1", committedDate: old }, associatedPullRequests: { totalCount: 0, nodes: [] } },
      { name: "feature/x", target: { oid: "tip", committedDate: old }, associatedPullRequests: { totalCount: 1, nodes: [null] } },
      { name: "feature/y", target: { oid: "tip2", committedDate: old }, associatedPullRequests: { totalCount: 0, nodes: [] } },
    ],
  };
  await check();
  // feature/x might be merged, so only feature/y is stale, and the count
  // says that more may exist.
  const stale = last().rows.find((row) => row.kind === "branches-stale");
  assert.equal(stale.count, "1+");
  assert.deepEqual(tipLists(stale), [["", ["feature/y"], 0]]);

  const noList = summarizeBranches(
    {
      defaultBranch: "main",
      remote: null,
      local: [
        { name: "alone", upstream: null, time: daysAgo(40) },
        { name: "tracked", upstream: "feature/t", time: daysAgo(40) },
      ],
    },
    NOW,
  );
  assert.deepEqual(noList.stale.branches, [{ name: "alone", time: daysAgo(40), days: 40, github: false }]);
  assert.equal(noList.stale.capped, true);
});

test("local branches are read by their full name and tracked GitHub name", () => {
  const source = fs.readFileSync(path.join(root, "src", "repo-status.js"), "utf8");
  assert.match(source, /%\(refname:lstrip=2\)%00%\(upstream:remotename\)%00%\(upstream:remoteref\)/);
});

test("a removed worktree falls back to the project folder", async () => {
  const { check, last } = createHarness({ folder: ["C:\\gone", "C:\\repo"] });
  await check();
  assert.equal(last().repo, "o/r");
  assert.deepEqual(last().rows.map((row) => row.kind), ["issues"]);
});

test("open accepts only known pages of the repository shown", async () => {
  const { service, state, check } = createHarness();
  await service.handle("s1", JSON.stringify({ type: "open", repo: "o/r", kind: "issues" }));
  assert.deepEqual(state.opened, []);
  await check();
  await service.handle("s1", JSON.stringify({ type: "open", repo: "o/r", kind: "issues" }));
  await service.handle("s1", JSON.stringify({ type: "open", repo: "o/r", kind: "https://evil.example" }));
  await service.handle("s1", "not json");
  assert.deepEqual(state.opened, ["https://github.com/o/r/issues"]);
  service.forget("s1");
  await service.handle("s1", JSON.stringify({ type: "open", repo: "o/r", kind: "pulls" }));
  assert.equal(state.opened.length, 1);
});

test("tooltip items and lists link to their own GitHub pages", () => {
  const rows = buildRows({
    issues: { value: 9, capped: false, items: [{ number: 12, title: "a", labels: [] }] },
    pulls: { value: 1, capped: false, items: [{ number: 58, title: "b" }] },
    dependabot: { value: 2, capped: false, alerts: [{ number: 4, severity: "high", package: "x" }, { number: null, severity: "low", package: "y" }] },
    codeScanning: { value: 1, capped: false, alerts: [{ number: 8, severity: "high", rule: "r" }] },
    secretScanning: { value: 1, capped: false, alerts: [{ number: 3, type: "t" }] },
    branches: summarizeBranches(
      {
        defaultBranch: "main",
        remote: {
          total: 3,
          capped: false,
          nodes: [
            { name: "main", time: daysAgo(1), merged: false },
            { name: "feature/תיקון#1%", time: daysAgo(40), merged: false },
            { name: "done", time: daysAgo(2), merged: true },
          ],
        },
        local: [
          { name: "work", upstream: "feature/תיקון#1%", time: daysAgo(41), track: "ahead 1" },
          { name: "gone", upstream: "gone", time: daysAgo(1), track: "gone" },
          { name: "spike", upstream: null, time: daysAgo(50), track: "" },
        ],
      },
      NOW,
    ),
  });
  const links = (kind) => rows.find((row) => row.kind === kind).detail.sections.map((section) => [
    section.link || null,
    section.items.map((item) => item.link || null),
  ]);
  // Eight issues are left out, so the line opens the list.
  assert.deepEqual(links("issues"), [["issues", ["issues/12"]]]);
  // A list of five or fewer, all shown, has no line.
  assert.deepEqual(links("pulls"), [[null, ["pull/58"]]]);
  assert.deepEqual(links("security"), [
    // An alert without a number has no page to open.
    [null, ["security/dependabot/4", null]],
    [null, ["security/code-scanning/8"]],
    [null, ["security/secret-scanning/3"]],
  ]);
  // Each part of a branch name is encoded, and the slashes between them stay.
  assert.deepEqual(links("branches-remote"), [[null, ["tree/done", "tree/feature/%D7%AA%D7%99%D7%A7%D7%95%D7%9F%231%25"]]]);
  // A local branch links to the GitHub branch it tracks, unless it is gone.
  // Local branches have no list on GitHub.
  assert.deepEqual(links("branches-local"), [[null, [null, "tree/feature/%D7%AA%D7%99%D7%A7%D7%95%D7%9F%231%25", null]]]);
  // The deleted branch is local only, so it has no page.
  assert.deepEqual(links("branches-dead"), [
    [null, ["tree/done"]],
    [null, [null]],
  ]);
  // A stale branch on GitHub links to it, and a local one does not.
  assert.deepEqual(links("branches-stale"), [[null, [null, "tree/feature/%D7%AA%D7%99%D7%A7%D7%95%D7%9F%231%25"]]]);
});

test("a branch name that is not a safe path has no link", () => {
  const remote = (names) => summarizeBranches(
    {
      defaultBranch: "main",
      remote: { total: names.length, capped: false, nodes: names.map((name) => ({ name, time: daysAgo(1), merged: false })) },
      local: [],
    },
    NOW,
  );
  const [row] = buildRows({ branches: remote(["a/../b", "./x", "a//b", "bad\uD800", "ok/name"]) });
  assert.deepEqual(
    row.detail.sections[0].items.map((item) => [item.text, item.link || null]),
    [["a/../b", null], ["./x", null], ["a//b", null], ["bad\uD800", null], ["ok/name", "tree/ok/name"]],
  );
});

test("the stale list links to GitHub only when every branch it stands for is there", () => {
  const stale = (localNames) => buildRows({
    branches: summarizeBranches(
      {
        defaultBranch: "main",
        remote: {
          total: 9,
          capped: false,
          nodes: Array.from({ length: 9 }, (_, i) => ({ name: `r${i}`, time: daysAgo(40 + i), merged: false })),
        },
        local: localNames.map((name) => ({ name, upstream: null, time: daysAgo(35) })),
      },
      NOW,
    ),
  }).find((row) => row.kind === "branches-stale").detail.sections[0];
  // Nine branches, all on GitHub, so the line opens the list there.
  const remoteOnly = stale([]);
  assert.equal(remoteOnly.items.length, 9);
  assert.equal(remoteOnly.more, 0);
  assert.equal(remoteOnly.link, "branches/all");
  // Two local branches are not on GitHub, so its list does not hold them.
  const mixed = stale(["l1", "l2"]);
  assert.equal(mixed.items.length, 11);
  assert.equal(mixed.link, undefined);
});

test("a list line links to GitHub only when every item left out has a page there", () => {
  const alerts = (numbers) => buildRows({
    codeScanning: { value: numbers.length, capped: false, alerts: numbers.map((number) => ({ number, severity: "high", rule: "r" })) },
  })[0].detail.sections[0];
  const numbered = (length) => Array.from({ length }, (_, i) => i + 1);
  // Six shown, each with a number, so the line opens them all.
  const six = alerts(numbered(6));
  assert.deepEqual([six.items.length, six.more, six.link], [6, 0, "security/code-scanning"]);
  // Five or fewer have no line.
  assert.equal(alerts(numbered(5)).link, undefined);
  // One without a number has no page there, so the line does not promise it.
  assert.equal(alerts([...numbered(5), null]).link, undefined);
  // Past 100, the line stands only for the items left out.
  const shownUnnumbered = alerts([null, ...numbered(101).slice(1)]);
  assert.deepEqual([shownUnnumbered.items.length, shownUnnumbered.more, shownUnnumbered.link], [100, 1, "security/code-scanning"]);
  const leftOutUnnumbered = alerts([...numbered(100), null]);
  assert.deepEqual([leftOutUnnumbered.more, leftOutUnnumbered.link], [1, undefined]);
});

test("the links change only after the page received the rows that hold them", async () => {
  const { service, state, check } = createHarness();
  state.time = NOW;
  const refs = (name) => ({
    totalCount: 2,
    nodes: [
      { name: "main", target: { oid: "a1", committedDate: new Date(daysAgo(1)).toISOString() }, associatedPullRequests: { totalCount: 0, nodes: [] } },
      { name, target: { oid: "b2", committedDate: new Date(daysAgo(1)).toISOString() }, associatedPullRequests: { totalCount: 0, nodes: [] } },
    ],
  });
  state.refs = refs("feature/old");
  await check();
  const open = (link) => service.handle("s1", JSON.stringify({ type: "open", repo: "o/r", link }));
  // The page navigates away while the next rows are sent, so it keeps the
  // earlier ones.
  state.refs = refs("feature/new");
  state.time += FRESH_MS + 1;
  state.failPush = true;
  await assert.rejects(check("focus"));
  await open("tree/feature/old");
  await open("tree/feature/new");
  assert.deepEqual(state.opened, ["https://github.com/o/r/tree/feature/old"]);
});

test("a check replaced by a newer one for the same thread sends nothing", async () => {
  const { state, check } = createHarness();
  await check();
  const before = state.pushes.length;
  // Both checks wait for the same lookup, and the earlier one ends first.
  state.time += FRESH_MS + 5 * 60 * 1000 + 1;
  state.holdGit = true;
  const first = check("focus");
  await new Promise((resolve) => setImmediate(resolve));
  const second = check("focus");
  await new Promise((resolve) => setImmediate(resolve));
  state.holdGit = false;
  for (const release of state.releases) release();
  await Promise.all([first, second]);
  assert.equal(state.pushes.length, before + 1);
});

test("the repository and its links change only together", async () => {
  // The page navigates away while its rows are sent, or takes the message
  // but not the rows, so it still shows the earlier ones.
  for (const failure of ["failPush", "rejectPush"]) {
    const { service, state, check } = createHarness();
    await check();
    const open = (repo) => service.handle("s1", JSON.stringify({ type: "open", link: "issues", repo }));
    // The thread's folder now has another origin.
    state.folder = "C:\\next";
    state.remotes = { "C:\\next": "https://github.com/n/m.git" };
    state.time += 5 * 60 * 1000 + 1;
    state[failure] = true;
    if (failure === "failPush") await assert.rejects(check("focus"));
    else await check("focus");
    await open("n/m");
    await open("o/r");
    assert.deepEqual(state.opened, ["https://github.com/o/r/issues"], failure);
  }
});

test("a removed project stops showing in a new thread at once", async () => {
  const { state, check, last } = createHarness();
  state.projects = { p1: ["C:\\project"] };
  const draft = "t3code://app/draft/d1";
  await check("navigate", draft, "p1");
  assert.equal(last().repo, "o/r");
  state.projects = {};
  await check("focus", draft, "p1");
  assert.deepEqual(state.projectLookups, ["p1", "p1"]);
  assert.deepEqual(last().rows, []);
});

test("a list read from one page of a longer one has a line without a count", () => {
  const alerts = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, severity: "high", rule: "r" }));
  const [row] = buildRows({ codeScanning: { value: 100, capped: true, alerts } });
  const [section] = row.detail.sections;
  assert.equal(row.count, "100+");
  assert.deepEqual([section.items.length, section.more, section.partial, section.link], [100, 0, true, "security/code-scanning"]);
  const [exact] = buildRows({ codeScanning: { value: 100, capped: false, alerts } })[0].detail.sections;
  assert.equal(exact.partial, undefined);
});

test("a link opens only when the page was sent it for the thread shown", async () => {
  const { service, state, check } = createHarness();
  state.time = NOW;
  state.refs = {
    totalCount: 2,
    nodes: [
      { name: "main", target: { oid: "a1", committedDate: new Date(daysAgo(1)).toISOString() }, associatedPullRequests: { totalCount: 0, nodes: [] } },
      { name: "feature/x", target: { oid: "b2", committedDate: new Date(daysAgo(1)).toISOString() }, associatedPullRequests: { totalCount: 0, nodes: [] } },
    ],
  };
  const open = (link, repo = "o/r") => service.handle("s1", JSON.stringify({ type: "open", link, repo }));
  await open("tree/feature/x");
  assert.deepEqual(state.opened, []);
  await check();
  for (const link of ["tree/feature/x", "branches/all", "tree/other", "../../evil", "https://evil.example", "issues/1"]) {
    await open(link);
  }
  await service.handle("s1", JSON.stringify({ type: "open", repo: "o/r", link: 5 }));
  // A click on a link of the repository shown before is ignored, and so is
  // a row click without the repository.
  await open("tree/feature/x", "other/repo");
  await open("tree/feature/x", null);
  await service.handle("s1", JSON.stringify({ type: "open", kind: "issues" }));
  // One branch has no list line, so the list is not one of the links.
  assert.deepEqual(state.opened, ["https://github.com/o/r/tree/feature/x"]);
  // Another thread starts with no links until its rows arrive.
  state.folder = () => null;
  await check("navigate", `t3code://app/${environmentId}/other-thread`);
  await open("tree/feature/x");
  assert.equal(state.opened.length, 1);
});

test("a new thread shows the status of its project's repository", async () => {
  const { state, check, last } = createHarness();
  state.projects = { p1: ["C:\\project"] };
  const draft = "t3code://app/draft/d1";
  await check("navigate", draft, "p1");
  assert.deepEqual(state.projectLookups, ["p1"]);
  assert.equal(state.folderLookups, 0);
  assert.equal(last().project, "p1");
  assert.equal(last().repo, "o/r");
  assert.deepEqual(last().rows.map((row) => row.kind), ["issues"]);
  // Without a project, or with an unsafe one, nothing is looked up.
  await check("navigate", draft);
  await check("navigate", draft, "a b");
  assert.deepEqual(state.projectLookups, ["p1"]);
  assert.deepEqual(last(), { path: draft, project: "a b", repo: null, rows: [] });
  // A project that is not in the database shows no section.
  await check("navigate", draft, "p2");
  assert.deepEqual(last().rows, []);
});

test("a new thread whose project changes drops the links of the earlier one", async () => {
  const { service, state, check, last } = createHarness();
  state.projects = { p1: ["C:\\project"], p2: ["C:\\other"] };
  const draft = "t3code://app/draft/d1";
  await check("navigate", draft, "p1");
  const open = () => service.handle("s1", JSON.stringify({ type: "open", kind: "issues", repo: "o/r" }));
  await open();
  assert.equal(state.opened.length, 1);
  // The project changes on the same address. Until its rows arrive, a click
  // on a row shown for the earlier project opens nothing.
  state.holdGit = true;
  const pending = check("navigate", draft, "p2");
  await new Promise((resolve) => setImmediate(resolve));
  await open();
  assert.equal(state.opened.length, 1);
  state.holdGit = false;
  for (const release of state.releases) release();
  await pending;
  assert.equal(last().project, "p2");
  await open();
  assert.equal(state.opened.length, 2);
});

test("the page script parses and renders text without HTML parsing", () => {
  const source = buildRepoStatusPageSource();
  assert.doesNotThrow(() => new Function(source));
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(source, /textContent/);
});

test("the launcher loads repository status on its own and honors the opt-out", () => {
  const launcher = fs.readFileSync(path.join(root, "src", "t3-rtl-launcher.js"), "utf8");
  assert.match(launcher, /readSettings\(\)\.repoStatus !== false/);
  assert.match(launcher, /try \{\s*const \{ REPO_STATUS_BINDING, createRepoStatusService \} = require\("\.\/repo-status"\)/);
  assert.match(launcher, /Repository status could not be added/);
  assert.match(launcher, /Page\.domContentEventFired[\s\S]*repoStatus\.reattach/);
  const windowsInstaller = fs.readFileSync(path.join(root, "windows", "install.ps1"), "utf8");
  const macInstaller = fs.readFileSync(path.join(root, "macos", "install.sh"), "utf8");
  assert.match(windowsInstaller, /"repo-status\.js"/);
  assert.match(macInstaller, /\$SRC\/repo-status\.js/);
});

test("repository status commands run without a shell", () => {
  const source = fs.readFileSync(path.join(root, "src", "repo-status.js"), "utf8");
  assert.match(source, /execFile\(/);
  assert.doesNotMatch(source, /shell:\s*true|(?<![.\w])exec\(|\bspawn\(|execSync|child_process"\)\.exec\b/);
});

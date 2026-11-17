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
    secretScanning: { ...count(2), alerts: [{ type: "" }, { type: "" }] },
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
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL);
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, worktree_path TEXT);
    INSERT INTO projection_projects VALUES ('p1', 'C:\\old-repo');
    INSERT INTO projection_threads VALUES ('t1', 'p1', NULL), ('t2', 'p1', 'C:\\old-worktree');
  `);
  assert.deepEqual(lookupThreadFolder(directory, "t1"), ["C:\\old-repo"]);
  assert.deepEqual(lookupThreadFolder(directory, "t2"), ["C:\\old-worktree", "C:\\old-repo"]);

  // Current releases write statev2.sqlite and leave state.sqlite behind.
  const payload = (id, worktreePath) => JSON.stringify({ id, worktreePath }).replace(/'/g, "''");
  create("statev2.sqlite", `
    CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, workspace_root TEXT NOT NULL);
    CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, payload_json TEXT NOT NULL);
    INSERT INTO projection_projects VALUES ('p1', 'C:\\repo');
    INSERT INTO orchestration_v2_projection_threads VALUES
      ('t1', 'p1', '${payload("t1", null)}'),
      ('mcp:launch:78de3208', 'p1', '${payload("mcp:launch:78de3208", "C:\\worktree")}');
  `);
  assert.deepEqual(lookupThreadFolder(directory, "t1"), ["C:\\repo"]);
  assert.deepEqual(lookupThreadFolder(directory, "mcp:launch:78de3208"), ["C:\\worktree", "C:\\repo"]);
  assert.equal(lookupThreadFolder(directory, "t2"), null);
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
      return { error: null, stdout: `${remote}\n`, stderr: "" };
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
    const match = /receive\((.*)\);/.exec(params.expression);
    state.pushes.push({ sessionId, data: JSON.parse(match[1]) });
    return {};
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
    open: async (url) => state.opened.push(url),
  });
  const check = (reason = "navigate", href = threadHref) =>
    service.handle("s1", JSON.stringify({ type: "check", path: href, reason }));
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
  await service.handle("s1", JSON.stringify({ type: "open", kind: "issues" }));
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
    { name: "feature/old", time: daysAgo(45), days: 45 },
    { name: "spike", time: daysAgo(40), days: 40 },
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
        value: 12,
        capped: false,
        partial: false,
        branches: Array.from({ length: 12 }, (_, i) => ({ name: `b${i}`, time: daysAgo(i), merged: i === 0 })),
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
    ["branches", "branches-remote", "Remote", "12"],
    ["branches", "branches-dead", "Dead", "2"],
    ["branches", "branches-stale", "Stale", "1+"],
  ]);
  assert.deepEqual(tipLists(rows[1]), [["", ["b0", "b1", "b2", "b3", "b4", "b5", "b6", "b7"], 4]]);
  assert.deepEqual(rows[1].detail.sections[0].items[0], {
    text: "b0",
    time: daysAgo(0),
    badges: [{ text: "Merged", tone: "success" }],
  });
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
          },
        ],
        more: 6,
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
  assert.deepEqual(secretScanning, { title: "Secret scanning · 1", items: [{ text: "GitHub Token" }], more: 0 });
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
                  { securityVulnerability: { severity: "MODERATE", package: { name: "lodash" } } },
                  { securityVulnerability: null },
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
        stdout: JSON.stringify([{ rule: { severity: "error", description: "SQL injection" }, most_recent_instance: { location: { path: "db.js" } } }]),
        stderr: "",
      };
    }
    return {
      error: null,
      stdout: JSON.stringify([{ secret_type: "token", secret_type_display_name: "GitHub Token", secret: "ghp_SECRETVALUE" }]),
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
    { severity: "medium", package: "lodash" },
    { severity: null, package: "" },
  ]);
  assert.deepEqual(status.codeScanning.alerts, [{ severity: "high", rule: "SQL injection", path: "db.js" }]);
  assert.deepEqual(status.secretScanning.alerts, [{ type: "GitHub Token" }]);
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

  await service.handle("s1", JSON.stringify({ type: "open", kind: "branches-local" }));
  await service.handle("s1", JSON.stringify({ type: "open", kind: "branches-dead" }));
  await service.handle("s1", JSON.stringify({ type: "open", kind: "constructor" }));
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
    { name: "worktree-agent-1", time: daysAgo(61), days: 61 },
    { name: "shared-name", time: daysAgo(50), days: 50 },
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
  assert.deepEqual(summary.stale.branches, [{ name: "feature/old", time: daysAgo(40), days: 40 }]);
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
  assert.deepEqual(noList.stale.branches, [{ name: "alone", time: daysAgo(40), days: 40 }]);
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
  await service.handle("s1", JSON.stringify({ type: "open", kind: "issues" }));
  assert.deepEqual(state.opened, []);
  await check();
  await service.handle("s1", JSON.stringify({ type: "open", kind: "issues" }));
  await service.handle("s1", JSON.stringify({ type: "open", kind: "https://evil.example" }));
  await service.handle("s1", "not json");
  assert.deepEqual(state.opened, ["https://github.com/o/r/issues"]);
  service.forget("s1");
  await service.handle("s1", JSON.stringify({ type: "open", kind: "pulls" }));
  assert.equal(state.opened.length, 1);
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

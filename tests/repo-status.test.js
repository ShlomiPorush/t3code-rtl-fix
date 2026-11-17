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
  assert.equal(rows[1].title, "Dependabot: 2, Code scanning: 100+");
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
  const status = await fetchCounts(run, parseGitHubRemote("https://github.com/o/r"));
  assert.deepEqual(status, {
    issues: count(4),
    pulls: count(1),
    dependabot: null,
    codeScanning: null,
    secretScanning: count(2),
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
  };
  const hold = () => new Promise((resolve) => state.releases.push(resolve));
  const run = async (file, args) => {
    if (file === "git") {
      if (state.holdGit) await hold();
      if (args[1] === "C:\\gone") return { error: new Error("not a git repository"), stdout: "", stderr: "fatal" };
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

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { countWorkflowRuns, createHomeWorkflows, readWorkflowCounts } = require("../src/home-workflows");

const run = (id, overrides = {}) => ({ id, parent: null, status: "running", ended: 0, ...overrides });

test("a run counts once with the runs it invoked, and needs you when it or one below it asks or is paused", () => {
  const runs = [
    run("plain"),
    run("asks", { status: "waiting" }),
    run("parent", { status: "waiting" }),
    run("child", { parent: "parent", status: "waiting" }),
    run("grandchild", { parent: "child", status: "paused" }),
    run("orphan", { parent: "gone" }),
    run("done", { status: "completed", ended: 1 }),
  ];
  assert.deepEqual(countWorkflowRuns(runs, ["asks"]), { running: 2, needsYou: 2, finished: 0 });
  assert.deepEqual(countWorkflowRuns(runs, ["asks", "asks", "orphan"]), { running: 1, needsYou: 3, finished: 0 });
  assert.deepEqual(countWorkflowRuns([], []), { running: 0, needsYou: 0, finished: 0 });
});

test("runs that name each other as parents are still counted", () => {
  const runs = [run("a", { parent: "b" }), run("b", { parent: "a" })];
  assert.deepEqual(countWorkflowRuns(runs, []), { running: 2, needsYou: 0, finished: 0 });
});

test("an ended run with an unread answer is finished once, with its children, and not while its root is open", () => {
  const runs = [
    run("open-parent"),
    run("ended-child", { parent: "open-parent", status: "completed", ended: 1 }),
    run("tree", { status: "completed", ended: 1 }),
    run("tree-child", { parent: "tree", status: "completed", ended: 1 }),
    run("stopped", { status: "stopped", ended: 1 }),
    run("cancelled", { status: "cancelled", ended: 1 }),
  ];
  assert.deepEqual(
    countWorkflowRuns(runs, [], ["ended-child", "tree", "tree-child", "stopped", "cancelled", "unknown"]),
    { running: 1, needsYou: 0, finished: 2 },
  );
});

function userdata(t, { enabled = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-home-workflows-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ workflowsEnabled: enabled }));
  return directory;
}

function sqliteOrSkip(t) {
  try {
    return require("node:sqlite").DatabaseSync;
  } catch {
    t.skip("node:sqlite is unavailable in this Node.js");
    return null;
  }
}

function database(DatabaseSync, directory, schema) {
  const written = new DatabaseSync(path.join(directory, "statev2.sqlite"));
  written.exec(schema);
  written.close();
  return (file) => new DatabaseSync(file, { readOnly: true });
}

const thread = (id, visitedAt, archivedAt = null) =>
  `('${id}', ${archivedAt ? `'${archivedAt}'` : "NULL"}, NULL, '${JSON.stringify({ lastVisitedAt: visitedAt })}')`;

const SCHEMA = `
  CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY, workflow TEXT NOT NULL, status TEXT NOT NULL, ended_at TEXT, parent_run_id TEXT);
  CREATE TABLE workflow_waits (run_id TEXT NOT NULL, name TEXT NOT NULL, request_json TEXT, signalled_at TEXT, PRIMARY KEY (run_id, name));
  CREATE TABLE workflow_steps (run_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, thread_id TEXT, PRIMARY KEY (run_id, name));
  CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL);
  CREATE TABLE orchestration_v2_projection_runs (run_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, ordinal INTEGER NOT NULL, status TEXT NOT NULL, completed_at TEXT);
  INSERT INTO workflow_runs VALUES ('busy', 'w', 'running', NULL, NULL), ('asks', 'w', 'waiting', NULL, NULL),
    ('sleeps', 'w', 'waiting', NULL, NULL), ('answered', 'w', 'waiting', NULL, NULL),
    ('unread', 'w', 'completed', '2026-11-25T10:00:00Z', NULL), ('read', 'w', 'completed', '2026-11-25T10:00:00Z', NULL),
    ('never-opened', 'w', 'stopped', '2026-11-25T10:00:00Z', NULL), ('archived', 'w', 'completed', '2026-11-25T10:00:00Z', NULL),
    ('again', 'w', 'completed', '2026-11-25T10:00:00Z', NULL);
  INSERT INTO workflow_waits VALUES ('asks', 'ship', '{"title":"Ship?"}', NULL), ('asks', 'deploy', '{"title":"Deploy?"}', NULL),
    ('sleeps', 'nap', NULL, NULL), ('answered', 'ship', '{"title":"Ship?"}', '2026-11-25T00:00:00Z');
  INSERT INTO workflow_steps VALUES ('busy', 'work', 'agent', 't-busy'), ('unread', 'work', 'agent', 't-unread'),
    ('read', 'work', 'agent', 't-read'), ('never-opened', 'work', 'agent', 't-never'), ('archived', 'work', 'agent', 't-archived'),
    ('again', 'work', 'agent', 't-again'), ('read', 'ship', 'ask', NULL);
  INSERT INTO orchestration_v2_projection_threads VALUES ${[
    thread("t-busy", "2026-11-25T08:00:00.000Z"),
    thread("t-unread", "2026-11-25T08:00:00.000Z"),
    thread("t-read", "2026-11-25T09:30:00.000Z"),
    thread("t-never", null),
    thread("t-archived", "2026-11-25T08:00:00.000Z", "2026-11-25T11:00:00.000Z"),
    thread("t-again", "2026-11-25T09:30:00.000Z"),
  ].join(", ")};
  INSERT INTO orchestration_v2_projection_runs VALUES
    ('r-busy', 't-busy', 1, 'running', NULL),
    ('r-unread', 't-unread', 1, 'completed', '2026-11-25T09:00:00.000Z'),
    ('r-read', 't-read', 1, 'completed', '2026-11-25T09:00:00.000Z'),
    ('r-never', 't-never', 1, 'completed', '2026-11-25T09:00:00.000Z'),
    ('r-archived', 't-archived', 1, 'completed', '2026-11-25T09:00:00.000Z'),
    ('r-again-1', 't-again', 1, 'completed', '2026-11-25T09:00:00.000Z'),
    ('r-again-2', 't-again', 2, 'interrupted', '2026-11-25T09:45:00.000Z');
`;

test("runs and the read marks of their agents' threads are read from T3 Code's database", (t) => {
  const DatabaseSync = sqliteOrSkip(t);
  if (!DatabaseSync) return;
  const directory = userdata(t);
  assert.deepEqual(readWorkflowCounts(directory, database(DatabaseSync, directory, SCHEMA)), { running: 3, needsYou: 1, finished: 2 });
});

test("nothing is read while workflows are off in T3 Code", (t) => {
  const directory = userdata(t, { enabled: false });
  assert.equal(readWorkflowCounts(directory, () => assert.fail("the database was opened")), null);
  fs.writeFileSync(path.join(directory, "settings.json"), "not json");
  assert.equal(readWorkflowCounts(directory, () => assert.fail("the database was opened")), null);
});

test("a window gets the counts at once, then only when they change, until it is forgotten", (t) => {
  let counts = { running: 1, needsYou: 0 };
  const open = () => ({
    prepare: (query) => ({
      all: () => {
        if (query.includes("workflow_waits")) return Array.from({ length: counts.needsYou }, (_, index) => ({ id: `r${index}` }));
        if (query.includes("workflow_steps")) return [];
        return Array.from({ length: counts.running + counts.needsYou }, (_, index) => ({ id: `r${index}`, parent: null, status: "waiting", ended: 0 }));
      },
    }),
    close() {},
  });
  const service = createHomeWorkflows({ userdata: userdata(t), openDatabase: open });
  const first = [];
  const second = [];
  service.read("a", (value) => first.push(value));
  service.read("b", (value) => second.push(value));
  service.check();
  counts = { running: 1, needsYou: 1 };
  service.check();
  service.forget("a");
  counts = { running: 0, needsYou: 0 };
  service.check();
  service.forget("b");
  const one = { running: 1, needsYou: 0, finished: 0 };
  const two = { running: 1, needsYou: 1, finished: 0 };
  assert.deepEqual(first, [one, two]);
  assert.deepEqual(second, [one, two, { running: 0, needsYou: 0, finished: 0 }]);
});

test("a database T3 Code changed hides the line and is logged once", (t) => {
  const DatabaseSync = sqliteOrSkip(t);
  if (!DatabaseSync) return;
  const directory = userdata(t);
  const logged = [];
  const failing = createHomeWorkflows({ userdata: directory, openDatabase: database(DatabaseSync, directory, "CREATE TABLE other (id TEXT)"), log: (line) => logged.push(line) });
  const shown = [];
  failing.read("a", (value) => shown.push(value));
  failing.read("b", (value) => shown.push(value));
  failing.forget("a");
  failing.forget("b");
  assert.deepEqual(shown, [null, null]);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /workflow runs could not be read/);
});

test("nothing is read while Home is off", (t) => {
  const off = createHomeWorkflows({ userdata: userdata(t), isOn: () => false, openDatabase: () => assert.fail("the database was opened") });
  off.read("a", (value) => assert.equal(value, null));
  off.forget("a");
});

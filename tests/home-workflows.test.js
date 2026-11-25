"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { countWorkflowRuns, createHomeWorkflows, readWorkflowCounts } = require("../src/home-workflows");

const run = (id, overrides = {}) => ({ id, parent: null, status: "running", ...overrides });

test("a run counts once with the runs it invoked, and needs you when it or one below it asks or is paused", () => {
  const runs = [
    run("plain"),
    run("asks", { status: "waiting" }),
    run("parent", { status: "waiting" }),
    run("child", { parent: "parent", status: "waiting" }),
    run("grandchild", { parent: "child", status: "paused" }),
    run("orphan", { parent: "ended-parent" }),
  ];
  assert.deepEqual(countWorkflowRuns(runs, ["asks"]), { running: 2, needsYou: 2 });
  assert.deepEqual(countWorkflowRuns(runs, ["asks", "asks", "orphan"]), { running: 1, needsYou: 3 });
  assert.deepEqual(countWorkflowRuns([], []), { running: 0, needsYou: 0 });
});

test("runs that name each other as parents are still counted", () => {
  const runs = [run("a", { parent: "b" }), run("b", { parent: "a" })];
  assert.deepEqual(countWorkflowRuns(runs, []), { running: 2, needsYou: 0 });
});

function userdata({ enabled = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-home-workflows-"));
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

const SCHEMA = `
  CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY, workflow TEXT NOT NULL, status TEXT NOT NULL, ended_at TEXT, parent_run_id TEXT);
  CREATE TABLE workflow_waits (run_id TEXT NOT NULL, name TEXT NOT NULL, request_json TEXT, signalled_at TEXT, PRIMARY KEY (run_id, name));
  INSERT INTO workflow_runs VALUES ('busy', 'w', 'running', NULL, NULL), ('asks', 'w', 'waiting', NULL, NULL),
    ('sleeps', 'w', 'waiting', NULL, NULL), ('done', 'w', 'completed', '2026-11-25T00:00:00Z', NULL),
    ('answered', 'w', 'waiting', NULL, NULL);
  INSERT INTO workflow_waits VALUES ('asks', 'ship', '{"title":"Ship?"}', NULL), ('asks', 'deploy', '{"title":"Deploy?"}', NULL),
    ('sleeps', 'nap', NULL, NULL), ('answered', 'ship', '{"title":"Ship?"}', '2026-11-25T00:00:00Z');
`;

test("open runs are read from T3 Code's database, and a question counts only while it is unanswered", (t) => {
  const DatabaseSync = sqliteOrSkip(t);
  if (!DatabaseSync) return;
  const directory = userdata();
  assert.deepEqual(readWorkflowCounts(directory, database(DatabaseSync, directory, SCHEMA)), { running: 3, needsYou: 1 });
});

test("nothing is read while workflows are off in T3 Code", () => {
  const directory = userdata({ enabled: false });
  assert.equal(readWorkflowCounts(directory, () => assert.fail("the database was opened")), null);
  fs.writeFileSync(path.join(directory, "settings.json"), "not json");
  assert.equal(readWorkflowCounts(directory, () => assert.fail("the database was opened")), null);
});

test("a window gets the counts at once, then only when they change, until it is forgotten", () => {
  let counts = { running: 1, needsYou: 0 };
  const open = () => ({
    prepare: (query) => ({
      all: () => (query.includes("workflow_waits") ? Array.from({ length: counts.needsYou }, (_, index) => ({ id: `r${index}` })) : Array.from({ length: counts.running + counts.needsYou }, (_, index) => ({ id: `r${index}`, parent: null, status: "waiting" }))),
    }),
    close() {},
  });
  const service = createHomeWorkflows({ userdata: userdata(), openDatabase: open });
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
  assert.deepEqual(first, [{ running: 1, needsYou: 0 }, { running: 1, needsYou: 1 }]);
  assert.deepEqual(second, [{ running: 1, needsYou: 0 }, { running: 1, needsYou: 1 }, { running: 0, needsYou: 0 }]);
});

test("a database T3 Code changed hides the line and is logged once", (t) => {
  const DatabaseSync = sqliteOrSkip(t);
  if (!DatabaseSync) return;
  const directory = userdata();
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

test("nothing is read while Home is off", () => {
  const off = createHomeWorkflows({ userdata: userdata(), isOn: () => false, openDatabase: () => assert.fail("the database was opened") });
  off.read("a", (value) => assert.equal(value, null));
  off.forget("a");
});

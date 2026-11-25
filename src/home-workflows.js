"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CHECK_MS = 15 * 1000;

const OPEN_RUNS = "SELECT run_id AS id, parent_run_id AS parent, status FROM workflow_runs WHERE ended_at IS NULL";
const ASKING_RUNS = "SELECT DISTINCT run_id AS id FROM workflow_waits WHERE request_json IS NOT NULL AND signalled_at IS NULL";

function countWorkflowRuns(runs, askingIds) {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const asking = new Set(askingIds);
  const rootOf = (run) => {
    const seen = new Set([run.id]);
    let current = run;
    while (current.parent && byId.has(current.parent) && !seen.has(current.parent)) {
      current = byId.get(current.parent);
      seen.add(current.id);
    }
    return current.id;
  };
  const roots = new Set();
  const needed = new Set();
  for (const run of runs) {
    const root = rootOf(run);
    roots.add(root);
    if (run.status === "paused" || asking.has(run.id)) needed.add(root);
  }
  return { running: roots.size - needed.size, needsYou: needed.size };
}

function workflowsEnabled(userdata) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userdata, "settings.json"), "utf8")).workflowsEnabled === true;
  } catch {
    return false;
  }
}

function readWorkflowCounts(userdata, openDatabase) {
  if (!workflowsEnabled(userdata)) return null;
  const database = openDatabase(path.join(userdata, "statev2.sqlite"));
  try {
    return countWorkflowRuns(
      database.prepare(OPEN_RUNS).all(),
      database.prepare(ASKING_RUNS).all().map((row) => row.id),
    );
  } finally {
    database.close();
  }
}

function openReadOnly(file) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(file, { readOnly: true });
}

function createHomeWorkflows({ userdata, log = () => {}, isOn = () => true, openDatabase = openReadOnly, checkMs = CHECK_MS } = {}) {
  const windows = new Map();
  let timer = null;
  let last = null;
  let lastProblem = null;

  function current() {
    if (!isOn()) return null;
    try {
      const counts = readWorkflowCounts(userdata, openDatabase);
      lastProblem = null;
      return counts;
    } catch (error) {
      if (error.message !== lastProblem) log(`Home: workflow runs could not be read: ${error.message}`);
      lastProblem = error.message;
      return null;
    }
  }

  function check(asker = null) {
    const counts = current();
    const text = JSON.stringify(counts);
    if (text !== last) {
      last = text;
      for (const deliver of windows.values()) deliver(counts);
    } else if (asker) {
      asker(counts);
    }
  }

  function read(key, deliver) {
    windows.set(key, deliver);
    check(deliver);
    timer ||= setInterval(check, checkMs);
    timer.unref?.();
  }

  function forget(key) {
    windows.delete(key);
    if (windows.size > 0) return;
    clearInterval(timer);
    timer = null;
  }

  return { read, forget, check };
}

module.exports = { CHECK_MS, countWorkflowRuns, createHomeWorkflows, readWorkflowCounts };

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CHECK_MS = 15 * 1000;

const RUNS = "SELECT run_id AS id, parent_run_id AS parent, status, ended_at IS NOT NULL AS ended FROM workflow_runs";
const ASKING_RUNS = "SELECT run_id AS id FROM workflow_waits WHERE request_json IS NOT NULL AND signalled_at IS NULL";
const AGENT_ANSWERS = `
  SELECT s.run_id AS id, json_extract(t.payload_json, '$.lastVisitedAt') AS visitedAt, r.status, r.completed_at AS completedAt
  FROM workflow_steps s
  JOIN orchestration_v2_projection_threads t ON t.thread_id = s.thread_id AND t.archived_at IS NULL AND t.deleted_at IS NULL
  JOIN orchestration_v2_projection_runs r ON r.run_id = (
    SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = s.thread_id ORDER BY ordinal DESC LIMIT 1
  )
  WHERE s.kind = 'agent'`;
const ENDED_WITH_ANSWER = new Set(["completed", "stopped"]);

const isUnread = ({ visitedAt, status, completedAt }) =>
  status === "completed" && (!visitedAt || Date.parse(completedAt) > Date.parse(visitedAt));

function countWorkflowRuns(runs, askingIds, unreadIds = []) {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const asking = new Set(askingIds);
  const rootOf = (run) => {
    const seen = new Set([run.id]);
    let current = run;
    while (current.parent && byId.has(current.parent) && !seen.has(current.parent)) {
      current = byId.get(current.parent);
      seen.add(current.id);
    }
    return current;
  };
  const open = new Set();
  const needed = new Set();
  for (const run of runs.filter((item) => !item.ended)) {
    const root = rootOf(run).id;
    open.add(root);
    if (run.status === "paused" || asking.has(run.id)) needed.add(root);
  }
  const finished = new Set();
  for (const id of unreadIds) {
    const root = byId.has(id) ? rootOf(byId.get(id)) : null;
    if (root && !open.has(root.id) && ENDED_WITH_ANSWER.has(root.status)) finished.add(root.id);
  }
  return { running: open.size - needed.size, needsYou: needed.size, finished: finished.size };
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
      database.prepare(RUNS).all(),
      database.prepare(ASKING_RUNS).all().map((row) => row.id),
      database.prepare(AGENT_ANSWERS).all().filter(isUnread).map((row) => row.id),
    );
  } finally {
    database.close();
  }
}

function openReadOnly(file) {
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(file, { readOnly: true });
}

function createHomeWorkflows({ userdata, log = () => {}, isOn = () => true, openDatabase = openReadOnly } = {}) {
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
    timer ||= setInterval(check, CHECK_MS);
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

module.exports = { countWorkflowRuns, createHomeWorkflows, readWorkflowCounts };

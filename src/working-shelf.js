"use strict";

// The Working section in the boring sidebar.
//
// T3 Code folds working threads into a Working section, but turns it off when
// the boring sidebar (Labs, group by project) is on. With this option on, the
// launcher rewrites T3 Code's sidebar code as the page loads it, so that:
// - the Working section also shows with the boring sidebar, still behind
//   T3 Code's own "Working section" setting, and
// - with the boring sidebar only, the section sits at the top of the
//   sidebar, above Pinned, in the rows, in their keyboard order, and in the
//   spacing that keeps the other shelves at the bottom.
//
// Every site must match exactly once before anything changes. Otherwise the
// code is passed on byte for byte, so a T3 Code update that changes this code
// turns the option off instead of breaking the sidebar. Names are read from
// the code around stable strings, never written in here, because the minified
// names change with every build.
//
// This module has no side effects when it is loaded, so tests can use it.

const ID = "[\\w$]+";
const URL_PATTERN = "t3code://app/assets/main-*.js";

function escapeId(name) {
  return name.replace(/\$/g, "\\$");
}

function allMatches(source, regex) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return [...source.matchAll(new RegExp(regex.source, flags))];
}

// The single match of regex in source[from, to), or a problem.
function single(source, regex, label, from = 0, to = source.length) {
  const found = allMatches(source.slice(from, to), regex);
  if (found.length !== 1) return { problem: `${label}: ${found.length} matches` };
  const match = found[0];
  match.index += from;
  return { match };
}

// Moves the Working header and its rows to the front of the sidebar's rows,
// keeping their order. Returns the same array when there are none, so React
// memoization keeps working while nothing is working.
const REORDER =
  '(a=>{const w=a.filter(e=>e.kind==="marker"?e.marker==="working-header":e.section==="working");' +
  "return w.length===0?a:[...w,...a.filter(e=>!w.includes(e))]})";

// How far after the start of the sidebar hook its row lists are built.
const HOOK_WINDOW = 8000;
// How far after the last fixed row of the sidebar the rows are handed on.
const ROWS_WINDOW = 600;

function patchSidebarChunk(source) {
  const unchanged = (problem) => ({ source, applied: false, problem });
  if (typeof source !== "string") return unchanged("not text");

  // The selector of T3 Code's own setting.
  const selector = single(source, new RegExp(`function (${ID})\\(e\\)\\{return e\\.sidebarWorkingShelfEnabled\\}`), "setting");
  if (selector.problem) return unchanged(selector.problem);
  const setting = escapeId(selector.match[1]);

  // The gate in the sidebar hook: "setting && folderGroups === null". The
  // folder groups are the boring sidebar's project folders.
  const gate = single(
    source,
    new RegExp(`folderGroups:(${ID})(?:,${ID}:${ID})*\\}=e,${ID}=${ID}\\(${setting}\\)(&&(${ID})===null),`),
    "gate",
  );
  if (gate.problem) return unchanged(gate.problem);
  if (gate.match[1] !== gate.match[3]) return unchanged("gate: not the folder groups");
  const groups = escapeId(gate.match[1]);
  const gateStart = gate.match.index + gate.match[0].lastIndexOf(gate.match[2]);
  const hookEnd = Math.min(source.length, gate.match.index + HOOK_WINDOW);

  // The rendered project folders, built from the folder groups in the hook,
  // and the order of the sidebar's threads for keyboard selection.
  const folders = single(source, new RegExp(`(${ID})=${groups}===null\\?null:`), "folders", gate.match.index, hookEnd);
  if (folders.problem) return unchanged(folders.problem);
  const folderList = escapeId(folders.match[1]);
  const keys = single(
    source,
    new RegExp(`=\\[(\\.\\.\\.${ID},\\.\\.\\.${folderList}===null\\?${ID}:${folderList}\\.flatMap\\(${ID}\\),)\\.\\.\\.(${ID}),`),
    "keys",
    gate.match.index,
    hookEnd,
  );
  if (keys.problem) return unchanged(keys.problem);

  // The folders as the sidebar renders them: active threads are drawn in
  // their folders when there are folders.
  const render = single(source, new RegExp(`if\\((${ID})!==null&&${ID}\\.section===\`active\`\\)continue`), "render");
  if (render.problem) return unchanged(render.problem);
  const renderFolders = render.match[1];

  // The sidebar's rows, handed on right after the last fixed row: the first
  // hand-off after each such row, which must be one place in all.
  const handOffs = new Map();
  for (const row of allMatches(source, /\{kind:`marker`,marker:`settled-placeholder`\}/)) {
    const after = new RegExp(`\\}let (${ID})=(${ID}),(${ID});`, "g");
    after.lastIndex = row.index;
    const found = after.exec(source);
    if (found && found.index < row.index + ROWS_WINDOW) handOffs.set(found.index, found);
  }
  if (handOffs.size !== 1) return unchanged(`rows: ${handOffs.size} matches`);
  const [rows] = handOffs.values();

  // The spacing that keeps the shelves at the bottom of the sidebar.
  const working = single(source, /marker:`working-header`,className:`mt-auto`/, "working header");
  if (working.problem) return unchanged(working.problem);
  const snoozed = single(
    source,
    new RegExp(`marker:\`snoozed-header\`,className:(${ID})\\((${ID})\\.length===0&&\`mt-auto\`\\)`),
    "snoozed header",
  );
  if (snoozed.problem) return unchanged(snoozed.problem);
  const settled = single(
    source,
    new RegExp(`marker:\`settled-header\`,className:(${ID})\\((${ID})\\.length\\+(${ID})\\.length===0&&\`mt-auto\`\\)`),
    "settled header",
  );
  if (settled.problem) return unchanged(settled.problem);

  const F = renderFolders;
  const edits = [
    // Show the Working section with the boring sidebar too.
    { start: gateStart, end: gateStart + gate.match[2].length, text: "" },
    // Working threads first in the keyboard order when there are folders.
    {
      start: keys.match.index,
      end: keys.match.index + keys.match[0].length,
      text: `=[...${folders.match[1]}!==null?${keys.match[2]}:[],${keys.match[1]}...${folders.match[1]}!==null?[]:${keys.match[2]},`,
    },
    // Working rows first when there are folders.
    {
      start: rows.index,
      end: rows.index + rows[0].length,
      text: `}let ${rows[1]}=${F}!==null?${REORDER}(${rows[2]}):${rows[2]},${rows[3]};`,
    },
    // The first shelf at the bottom is Snoozed or Settled when there are folders.
    {
      start: working.match.index,
      end: working.match.index + working.match[0].length,
      text: `marker:\`working-header\`,className:${F}===null?\`mt-auto\`:void 0`,
    },
    {
      start: snoozed.match.index,
      end: snoozed.match.index + snoozed.match[0].length,
      text: `marker:\`snoozed-header\`,className:${snoozed.match[1]}((${F}!==null||${snoozed.match[2]}.length===0)&&\`mt-auto\`)`,
    },
    {
      start: settled.match.index,
      end: settled.match.index + settled.match[0].length,
      text: `marker:\`settled-header\`,className:${settled.match[1]}(((${F}!==null?0:${settled.match[2]}.length)+${settled.match[3]}.length===0)&&\`mt-auto\`)`,
    },
  ].sort((a, b) => a.start - b.start);

  for (let i = 1; i < edits.length; i += 1) {
    if (edits[i].start < edits[i - 1].end) return unchanged("sites overlap");
  }
  let patched = "";
  let cursor = 0;
  for (const edit of edits) {
    patched += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  patched += source.slice(cursor);
  return { source: patched, applied: true };
}

// Answers the browser's paused requests for T3 Code's main script. Every
// paused request is answered once: patched when the option is on and the
// code is recognized, passed on unchanged otherwise.
function createWorkingShelfService({ send, isEnabled, log = () => {} } = {}) {
  const logged = new Set();
  const logOnce = (message) => {
    if (logged.has(message)) return;
    logged.add(message);
    log(`Working section: ${message}`);
  };

  // Interception stays on once enabled: turning the option off makes every
  // paused request pass unchanged, so no request is left waiting by a
  // Fetch.disable while its body is read.
  async function enable() {
    try {
      await send("Fetch.enable", {
        patterns: [{ urlPattern: URL_PATTERN, resourceType: "Script", requestStage: "Response" }],
      });
      return true;
    } catch (error) {
      logOnce(`could not watch T3 Code's script: ${error.message}`);
      return false;
    }
  }

  async function handlePaused(params = {}) {
    const requestId = params.requestId;
    if (!requestId) return;
    const pass = () =>
      send("Fetch.continueRequest", { requestId }).catch((error) => {
        logOnce(`could not pass T3 Code's script on: ${error.message}`);
      });
    try {
      if (!isEnabled() || params.responseStatusCode !== 200 || params.responseErrorReason) return await pass();
      const body = await send("Fetch.getResponseBody", { requestId });
      const text = body.base64Encoded ? Buffer.from(body.body || "", "base64").toString("utf8") : body.body || "";
      const result = patchSidebarChunk(text);
      if (!result.applied) {
        if (text.includes("sidebarWorkingShelfEnabled")) logOnce(`T3 Code's sidebar code was not recognized (${result.problem})`);
        return await pass();
      }
      // The option may have been turned off while the body was read.
      if (!isEnabled()) return await pass();
      const responseHeaders = (params.responseHeaders || []).filter(
        (header) => !/^(content-length|content-encoding)$/i.test(header.name || ""),
      );
      await send("Fetch.fulfillRequest", {
        requestId,
        responseCode: params.responseStatusCode,
        responseHeaders,
        body: Buffer.from(result.source, "utf8").toString("base64"),
      });
      logOnce("shown in the boring sidebar");
    } catch (error) {
      logOnce(`T3 Code's script was passed on unchanged: ${error.message}`);
      await pass();
    }
  }

  return { enable, handlePaused };
}

module.exports = { URL_PATTERN, patchSidebarChunk, createWorkingShelfService };

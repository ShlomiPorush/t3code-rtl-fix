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
//   spacing that keeps the other shelves at the bottom, and its rows look
//   like the rows in the project folders.
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

// The patch's own name for "the sidebar shows project folders".
const FOLDERS_FLAG = "t3RtlFixHasFolders$";

// How far after the start of the sidebar hook its row lists are built.
const HOOK_WINDOW = 8000;

// Whether another function starts between two places, so that names read at
// one place may not be in scope at the other.
function hasFunction(source, from, to) {
  return /\bfunction\b/.test(source.slice(from, to));
}

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
    new RegExp(`folderGroups:(${ID})(?:,${ID}:${ID})*\\}=e,(${ID})=${ID}\\(${setting}\\)(&&(${ID})===null),`),
    "gate",
  );
  if (gate.problem) return unchanged(gate.problem);
  if (gate.match[1] !== gate.match[4]) return unchanged("gate: not the folder groups");
  const groups = escapeId(gate.match[1]);
  const shelfEnabled = escapeId(gate.match[2]);
  const gateStart = gate.match.index + gate.match[0].lastIndexOf(gate.match[3]);
  const hookEnd = Math.min(source.length, gate.match.index + HOOK_WINDOW);
  const inHook = (label, regex) => single(source, regex, label, gate.match.index, hookEnd);

  // The order of the sidebar's threads for keyboard selection, in the same
  // hook: the pinned and active threads, the rendered project folders built
  // from the folder groups, and the visible rows of the Working section.
  const lists = {};
  for (const name of ["pinnedThreads", "activeThreads", "workingThreads"]) {
    const found = inHook(name, new RegExp(`[{,]${name}:(${ID})[,}]`));
    if (found.problem) return unchanged(found.problem);
    lists[name] = escapeId(found.match[1]);
  }
  const folders = inHook("folders", new RegExp(`[,;](${ID})=${groups}===null\\?null:`));
  if (folders.problem) return unchanged(folders.problem);
  const folderList = escapeId(folders.match[1]);
  const shown = inHook("working rows", new RegExp(`[,;](${ID})=${ID}\\?${lists.workingThreads}:${ID}\\(${lists.workingThreads},${ID}\\)[,;]`));
  if (shown.problem) return unchanged(shown.problem);
  const workingRows = shown.match[1];
  const keys = inHook(
    "keys",
    new RegExp(
      `[,;](${ID})=\\[(\\.\\.\\.${lists.pinnedThreads},\\.\\.\\.${folderList}===null\\?${lists.activeThreads}:${folderList}\\.flatMap\\(${ID}\\),)` +
        `\\.\\.\\.${escapeId(workingRows)},`,
    ),
  );
  if (keys.problem) return unchanged(keys.problem);
  if (hasFunction(source, gate.match.index, keys.match.index)) return unchanged("keys: not in the sidebar hook");
  // The list must be the keyboard order in the object the hook returns, the
  // one that also carries the gate's result and the project folders.
  const returned = inHook(
    "keyboard order",
    new RegExp(
      `\\{\\.\\.\\.${ID},threads:${ID},workingShelfEnabled:${shelfEnabled},[^{}]*?projectFolders:${folderList},` +
        `[^{}]*?orderedThreadKeys:${escapeId(keys.match[1])}\\.map\\(`,
    ),
  );
  if (returned.problem) return unchanged(returned.problem);
  // Nothing else in the hook sets the keyboard order over it.
  if (allMatches(source.slice(gate.match.index, hookEnd), /orderedThreadKeys:/).length !== 1) {
    return unchanged("keyboard order: set more than once");
  }
  const keysStart = keys.match.index + 1 + keys.match[1].length;

  // The sidebar component: its project folders F and its rows K are declared
  // in one let statement, the rows are handed on to the list that keys
  // React's state, and the folders are rendered without their active threads.
  const declared = single(
    source,
    new RegExp(`\\blet (?:[^;{}()\`'"]*?,)?${ID}=(${ID})!==null&&\\1\\.length>0,(${ID});`),
    "rows",
  );
  if (declared.problem) return unchanged(declared.problem);
  if (source.includes(FOLDERS_FLAG)) return unchanged("already changed");
  const F = declared.match[1];
  const K = escapeId(declared.match[2]);
  const declaredEnd = declared.match.index + declared.match[0].length - 1;
  const rows = single(
    source,
    new RegExp(`${K}=${ID}\\}let (${ID})=${K},(${ID});${ID}\\[\\d+\\]===\\1\\?\\2=${ID}\\[\\d+\\]:\\(\\2=\\1\\.map\\(`),
    "rows hand-off",
  );
  if (rows.problem) return unchanged(rows.problem);
  const render = single(source, new RegExp(`if\\(${escapeId(F)}!==null&&${ID}\\.section===\`active\`\\)continue`), "render");
  if (render.problem) return unchanged(render.problem);

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

  // The look of each row, which the row is rendered with: a row in a project
  // folder is a folder row, and a row in the Working, Pinned, or Active list
  // is a card.
  const look = single(
    source,
    new RegExp(
      `[,;](${ID})=(${ID})\\?${ID}\\?\`folder-multiline\`:\`folder\`:(${ID})===\`active\`\\|\\|\\3===\`pinned\`\\|\\|\\3===\`working\`\\?\`card\`:\`slim\`` +
        `;return\\(0,${ID}\\.jsx\\)\\(${ID},\\{(?:[^{}]*?,)?variant:\\1[,}]`,
    ),
    "row look",
  );
  if (look.problem) return unchanged(look.problem);
  const lookStart = look.match.index + 1 + look.match[1].length;

  const componentSites = [rows, render, working, snoozed, settled, look].map((site) => site.match.index);
  if (componentSites.some((index) => index < declared.match.index)) return unchanged("rows: sites out of order");
  if (hasFunction(source, declared.match.index, Math.max(...componentSites))) return unchanged("rows: not in one component");

  // Whether there are project folders is recorded in the statement where
  // T3 Code itself reads them, in a name of the patch's own that no minified
  // name can be. The places that read it do so inside try, so a place that
  // cannot see it keeps T3 Code's own layout instead of failing. Every other
  // added name is already used at the place it is added to.
  const hasFolders = `(()=>{try{return ${FOLDERS_FLAG}===!0}catch{return!1}})()`;

  // The rows hand-off: "}let Q=K,J;" becomes "}let Q=hasFolders?reorder(K):K,J;".
  const handOffStart = rows.match.index + rows.match[0].indexOf("}let ");
  const handOff = { index: handOffStart, Q: rows.match[1], J: rows.match[2] };
  const edits = [
    // "let …,G=F!==null&&F.length>0,K;" also declares the flag.
    { start: declaredEnd, end: declaredEnd, text: `,${FOLDERS_FLAG}=${F}!==null` },
    // Show the Working section with the boring sidebar too.
    { start: gateStart, end: gateStart + gate.match[3].length, text: "" },
    // Working threads first in the keyboard order when there are folders.
    {
      start: keysStart,
      end: keys.match.index + keys.match[0].length,
      text: `=[...${folders.match[1]}!==null?${workingRows}:[],${keys.match[2]}...${folders.match[1]}!==null?[]:${workingRows},`,
    },
    // Working rows first when there are folders.
    {
      start: handOff.index,
      end: handOff.index + `}let ${handOff.Q}=${declared.match[2]},${handOff.J};`.length,
      text: `}let ${handOff.Q}=${hasFolders}?${REORDER}(${declared.match[2]}):${declared.match[2]},${handOff.J};`,
    },
    // The first shelf at the bottom is Snoozed or Settled when there are folders.
    {
      start: working.match.index,
      end: working.match.index + working.match[0].length,
      text: `marker:\`working-header\`,className:${hasFolders}?void 0:\`mt-auto\``,
    },
    {
      start: snoozed.match.index,
      end: snoozed.match.index + snoozed.match[0].length,
      text: `marker:\`snoozed-header\`,className:${snoozed.match[1]}((${hasFolders}||${snoozed.match[2]}.length===0)&&\`mt-auto\`)`,
    },
    {
      start: settled.match.index,
      end: settled.match.index + settled.match[0].length,
      text: `marker:\`settled-header\`,className:${settled.match[1]}(((${hasFolders}?0:${settled.match[2]}.length)+${settled.match[3]}.length===0)&&\`mt-auto\`)`,
    },
    // Working rows look like the rows in the project folders when there are
    // folders: "a=n?" becomes "a=n||hasFolders&&t===`working`?".
    {
      start: lookStart,
      end: lookStart + `=${look.match[2]}?`.length,
      text: `=${look.match[2]}||${hasFolders}&&${look.match[3]}===\`working\`?`,
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
        logOnce(`T3 Code's sidebar code was not recognized (${result.problem})`);
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

  // Reloads T3 Code's windows without the cache, so each one loads the
  // sidebar script again and gets it as the switch now says. Only the windows
  // reload: T3 Code's server, and the sessions it runs, keep running.
  async function reloadWindows(sessionIds) {
    let reloaded = 0;
    for (const sessionId of sessionIds) {
      try {
        await send("Page.reload", { ignoreCache: true }, sessionId);
        reloaded += 1;
      } catch (error) {
        logOnce(`a window could not be reloaded: ${error.message}`);
      }
    }
    return reloaded;
  }

  return { enable, handlePaused, reloadWindows };
}

module.exports = { URL_PATTERN, patchSidebarChunk, createWorkingShelfService };

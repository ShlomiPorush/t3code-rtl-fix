"use strict";

// The Working and Done sections and the pinned rows in the boring sidebar.
//
// T3 Code folds working threads into a Working section, but turns it off when
// the boring sidebar (Labs, group by project) is on. Each part has its own
// switch. With one on, the launcher rewrites T3 Code's sidebar code as the page
// loads it, so that:
// - Working: T3 Code's Working section also shows with the boring sidebar,
//   still behind T3 Code's own "Working section" setting,
// - Done: the boring sidebar has a Done section of the threads that T3 Code
//   labels Input, which wait for the user's answer, or Done, which finished and
//   were not opened since,
// - Pinned: the pinned threads of the boring sidebar are plain rows, not cards, and
// - with the boring sidebar only, the sections sit at the top of the
//   sidebar, above Pinned, in the rows, in their keyboard order, and in the
//   spacing that keeps the other shelves at the bottom, and their rows look
//   like the rows in the project folders, with their project's icon.
//
// Every site must match exactly once before anything changes. Otherwise the
// code is passed on byte for byte, so a T3 Code update that changes this code
// turns the sections off instead of breaking the sidebar. Names are read from
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
// keeping their order, with the Done header and rows d after them. A Done
// thread is also an active row in a, which goes, because T3 Code's drag and
// drop needs each thread once. Returns the same array when there are none, so
// React memoization keeps working meanwhile.
const REORDER =
  '((a,d)=>{const w=a.filter(e=>e.kind==="marker"?e.marker==="working-header":e.section==="working");' +
  'return w.length+d.length===0?a:[...w,...d,...a.filter(e=>!w.includes(e)&&!(e.kind==="thread"&&d.some(o=>o.key===e.key)))]})';

// The patch's own name for "the sidebar shows project folders".
const FOLDERS_FLAG = "t3RtlFixHasFolders$";

const DONE_HOOK = "t3RtlFixUseDone$";
const DONE = "t3RtlFixDone$";

// How far after the start of the sidebar hook its row lists are built.
const HOOK_WINDOW = 8000;

// How far before a row's status label its thread's visits are read.
const LABEL_WINDOW = 3000;

// Whether another function starts between two places, so that names read at
// one place may not be in scope at the other. "typeof x==`function`" is not one.
function hasFunction(source, from, to) {
  return /\bfunction[\s*(]/.test(source.slice(from, to));
}

// Whether a name is imported or a function, so that code added to the module
// means the same by it as the place it was read from.
function isModuleName(source, name) {
  const id = escapeId(name);
  return new RegExp(`\\bimport\\{(?:[^}]*[\\s,])?${id}[,}]|\\bfunction ${id}\\(`).test(source);
}

// A thread is Done when it is ready and unread by the functions of T3 Code's own
// label, unless its run failed, which that label can also call Done. A thread
// that waits for input is in the section until it is answered. T3 Code marks
// a thread read when it opens, so the open thread stays until it is left, but a
// thread that finishes while it is open does not enter.
function doneHook({ status, unread, lastVisited, visits }) {
  return (
    `function ${DONE_HOOK}(threads,keyOf,openKey,react,useStored,schema){` +
    `const visited=${visits}(e=>e.threadLastVisitedAtById),[expanded,setExpanded]=useStored("t3-rtl-fix:sidebar:done-expanded",!0,schema),` +
    "kept=react.useRef(new Set),finished=threads.filter(e=>{" +
    `const key=keyOf(e),thread={...e,lastVisitedAt:${lastVisited}(e.lastVisitedAt,visited[key])};` +
    `return ${status}(thread)==="ready"&&(key===openKey?kept.current.has(key):${unread}(thread)&&e.latestRun.status!=="failed")` +
    "}).sort((a,b)=>Date.parse(b.latestRun?.completedAt)-Date.parse(a.latestRun?.completedAt))," +
    `done=[...threads.filter(e=>${status}(e)==="input"),...finished];` +
    "react.useLayoutEffect(()=>{kept.current=new Set(done.map(keyOf))});" +
    "const rows=expanded?done:done.filter(e=>keyOf(e)===openKey);" +
    "return{threads:done,rows,expanded,toggle:()=>setExpanded(e=>!e),items:done.length===0?[]:" +
    '[{kind:"marker",marker:"done-header"},...rows.map(e=>({kind:"thread",key:keyOf(e),section:"done"}))]}}'
  );
}

// The Done section's places in the sidebar hook, and the hook it adds before
// hookAt, at the top of the module.
function doneHookSites(source, { inHook, groups, activeThreads, folderList, expanded, openRow, hookAt }) {
  // T3 Code's hook for a shelf's saved state, and its React.
  const stored = inHook("done state", new RegExp(`\\[${escapeId(expanded)},${ID}\\]=(${ID})\\(${ID},!1,(${ID})\\)`));
  if (stored.problem) return stored;
  const react = inHook("done react", new RegExp(`\\(0,(${ID})\\.useSyncExternalStore\\)`));
  if (react.problem) return react;
  // The project folders, built from the active threads in a fresh array on
  // each render, so T3 Code's cache of the rendered list sees every change.
  const folders = inHook(
    "done folders",
    new RegExp(`[,;]${folderList}=(${groups})===null\\?null:${ID}\\(${groups},(${activeThreads}),${ID}\\)\\.map\\(`),
  );
  if (folders.problem) return folders;
  const keyOf = inHook("done keys", new RegExp(`orderedThreadKeys:${ID}\\.map\\((${ID})\\)`));
  if (keyOf.problem) return keyOf;
  // The sections of the rows. A drag on a row's settle button stays in one.
  const sectionOf = inHook("done sections", new RegExp(`,\\[${ID},\`settled\`\\](?=\\]\\)for\\()`));
  if (sectionOf.problem) return sectionOf;

  // A row's status label, which is Done when its thread is unread.
  const label = single(
    source,
    new RegExp(
      `[,;](${ID})=(${ID})\\(\\{\\.\\.\\.(${ID}),lastVisitedAt:(${ID})\\}\\),` +
        `(${ID})=(${ID})\\(\\{\\.\\.\\.\\3,lastVisitedAt:\\4\\}\\),`,
    ),
    "done label",
  );
  if (label.problem) return label;
  const [, isUnread, unread, thread, visited, rowStatus, status] = label.match;
  const text = single(
    source,
    new RegExp(
      `=${escapeId(rowStatus)}===\`preparing\`\\|\\|[^;]*?:${escapeId(isUnread)}\\?` +
        `\\{label:${ID}\\(\`Done\`,\\{\\$context:\`thread status\`\\}\\)`,
    ),
    "done label text",
    label.match.index,
    label.match.index + LABEL_WINDOW,
  );
  if (text.problem) return text;
  const visits = single(
    source,
    new RegExp(`let (${ID})=(${ID})\\(${ID}\\),${escapeId(visited)}=(${ID})\\(${escapeId(thread)}\\.lastVisitedAt,\\1\\)`),
    "done visits",
    Math.max(0, label.match.index - LABEL_WINDOW),
    label.match.index,
  );
  if (visits.problem) return visits;
  if (hasFunction(source, visits.match.index, text.match.index)) return { problem: "done label: not in one component" };

  const names = {
    status,
    unread,
    visits: visits.match[2],
    lastVisited: visits.match[3],
  };
  const foreign = Object.keys(names).find((key) => !isModuleName(source, names[key]));
  if (foreign) return { problem: `done hook: ${foreign} is not a name of the module` };

  const [, groupsName, activeName] = folders.match;
  const activeAt = folders.match.index + folders.match[0].indexOf(`(${groupsName},${activeName},`) + `(${groupsName},`.length;
  const sectionsEnd = sectionOf.match.index + sectionOf.match[0].length;
  return {
    edits: [
      { start: hookAt, end: hookAt, text: doneHook(names) },
      // The Done threads, before the folders, which no longer have them.
      {
        start: folders.match.index + 1,
        end: folders.match.index + 1,
        text:
          `${DONE}=${DONE_HOOK}(${groupsName}===null?[]:${activeName},${keyOf.match[1]},${openRow},` +
          `${react.match[1]},${stored.match[1]},${stored.match[2]}),`,
      },
      { start: activeAt + activeName.length, end: activeAt + activeName.length, text: `.filter(e=>!${DONE}.threads.includes(e))` },
      { start: sectionsEnd, end: sectionsEnd, text: `,[${DONE}.threads,\`done\`]` },
    ],
  };
}

// The Done section's places in the sidebar component, and in its header.
function doneListSites(source, { folderList, from }) {
  // Where the component takes the project folders from the hook.
  const taken = single(
    source,
    new RegExp(`,projectFolders:${escapeId(folderList)}(?=,[^;]*?\\}=${ID}\\(\\{projectScopeKey:)`),
    "done list",
    0,
    from,
  );
  if (taken.problem) return taken;
  const takenEnd = taken.match.index + taken.match[0].length;

  const header = single(
    source,
    new RegExp(
      `case\`working-header\`:(${ID})\\.push\\(\\(0,(${ID})\\.jsx\\)\\((${ID}),\\{marker:\`working-header\`,className:\`mt-auto\`,` +
        `label:(${ID})\\(\`Working\`,\\{\\$context:\`sidebar section\`\\}\\),count:${ID}\\.length,` +
        `toggle:\\{expanded:${ID},onToggle:${ID}\\}\\},\`working-shelf-header\`\\)\\);break (${ID});`,
    ),
    "done header",
    from,
  );
  if (header.problem) return header;
  if (hasFunction(source, taken.match.index, header.match.index)) return { problem: "done list: not in one component" };
  const [, list, jsx, component, translate, block] = header.match;

  // The header component's name for its shelf, which its rows have as parent.
  const shelf = single(
    source,
    new RegExp(`function ${escapeId(component)}\\(e\\)\\{let ${ID}=\\(0,${ID}\\.c\\)\\(\\d+\\),${ID}=(?=e\\.marker===\`working-header\`\\?\`working\`:)`),
    "done shelf",
  );
  if (shelf.problem) return shelf;
  const shelfEnd = shelf.match.index + shelf.match[0].length;

  return {
    edits: [
      { start: takenEnd, end: takenEnd, text: `,${DONE}` },
      {
        start: header.match.index,
        end: header.match.index,
        text:
          `case\`done-header\`:${list}.push((0,${jsx}.jsx)(${component},{marker:\`done-header\`,` +
          `label:${translate}(\`Done\`,{$context:\`thread status\`}),count:${DONE}.threads.length,` +
          `toggle:{expanded:${DONE}.expanded,onToggle:${DONE}.toggle}},\`done-shelf-header\`));break ${block};`,
      },
      { start: shelfEnd, end: shelfEnd, text: "e.marker===`done-header`?`done`:" },
    ],
  };
}

function patchSidebarChunk(source, sections) {
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
  const shown = inHook("working rows", new RegExp(`[,;](${ID})=(${ID})\\?${lists.workingThreads}:${ID}\\(${lists.workingThreads},(${ID})\\)[,;]`));
  if (shown.problem) return unchanged(shown.problem);
  const workingRows = shown.match[1];
  const doneHooked = sections.done
    ? doneHookSites(source, {
        inHook,
        groups,
        activeThreads: lists.activeThreads,
        folderList,
        expanded: shown.match[2],
        openRow: shown.match[3],
        hookAt: selector.match.index,
      })
    : { edits: [] };
  if (doneHooked.problem) return unchanged(doneHooked.problem);
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
  // The same row gets `shelf:working` as its navigation parent when it is in
  // the Working list, which is how the row component tells a Working row.
  const parent = single(
    source,
    new RegExp(`navigationParent:(${ID})\\?\\?\\((${ID})===\`working\`(?:\\|\\|\\2===\`\\w+\`)*\\?\`shelf:\\$\\{\\2\\}\`:void 0\\)[,}]`),
    "working parent",
  );
  if (parent.problem) return unchanged(parent.problem);
  const lookEnd = look.match.index + look.match[0].length;
  // It is the prop right after the variant, as in T3 Code's code.
  if (
    parent.match[1] !== look.match[2] ||
    parent.match[2] !== look.match[3] ||
    !look.match[0].endsWith(",") ||
    parent.match.index !== lookEnd
  ) {
    return unchanged("working parent: not the rendered row's");
  }

  // T3 Code's row component, for a row that is not a card: its folder flag A
  // (a folder row, one or two lines), the project icon it hides in folder
  // rows, cached by A, and the indent of folder rows under their folder.
  const flags = single(
    source,
    new RegExp(`if\\((${ID})!==\`card\`\\)\\{let (${ID})=\\1===\`folder-multiline\`,(${ID})=\\1===\`folder\`\\|\\|\\2,`),
    "row flags",
  );
  if (flags.problem) return unchanged(flags.problem);
  const A = escapeId(flags.match[3]);
  const icon = single(
    source,
    new RegExp(
      `(${ID})\\[(\\d+)\\]!==${A}\\|\\|\\1\\[\\d+\\]!==(${ID})\\.isActive\\|\\|\\1\\[\\d+\\]!==\\3\\.project\\|\\|\\1\\[\\d+\\]!==(${ID})\\?` +
        `\\(${ID}=${A}\\?null:\\(0,${ID}\\.jsx\\)\\(\`span\`,\\{className:${ID}\\(\`flex shrink-0 items-center transition-opacity\`,` +
        `\\(!\\3\\.isActive\\|\\|\\4===\`unsettle\`\\)&&\`[^\`]*\`\\),` +
        `children:\\3\\.project\\?\\(0,${ID}\\.jsx\\)\\(${ID},\\{project:\\3\\.project,className:\`size-4\`\\}\\):null\\}\\),\\1\\[\\2\\]=${A},`,
    ),
    "row icon",
  );
  if (icon.problem) return unchanged(icon.problem);
  const props = icon.match[3];
  const indent = single(
    source,
    new RegExp(
      `"data-sidebar-parent":(${ID})\\.navigationParent,[^{}]*?className:${ID}\\(${ID},${escapeId(flags.match[2])}\\?\`[^\`]*\`:\`[^\`]*\`,${A}&&\`ps-9\`\\)`,
    ),
    "row indent",
  );
  if (indent.problem) return unchanged(indent.problem);
  if (indent.match[1] !== props) return unchanged("row indent: not the row's own");
  const indentEnd = indent.match.index + indent.match[0].length;
  if (!(flags.match.index < icon.match.index && icon.match.index < indent.match.index) || hasFunction(source, flags.match.index, indentEnd)) {
    return unchanged("row: sites not in one component");
  }

  const componentSites = [rows, render, working, snoozed, settled, look].map((site) => site.match.index);
  if (componentSites.some((index) => index < declared.match.index)) return unchanged("rows: sites out of order");
  if (hasFunction(source, declared.match.index, Math.max(...componentSites))) return unchanged("rows: not in one component");

  const doneListed = sections.done ? doneListSites(source, { folderList: F, from: declared.match.index }) : { edits: [] };
  if (doneListed.problem) return unchanged(doneListed.problem);

  // Whether there are project folders is recorded in the statement where
  // T3 Code itself reads them, in a name of the patch's own that no minified
  // name can be. The places that read it do so inside try, so a place that
  // cannot see it keeps T3 Code's own layout instead of failing. Every other
  // name is already used at the place it is added to, or checked by the Done
  // section's sites.
  const hasFolders = `(()=>{try{return ${FOLDERS_FLAG}===!0}catch{return!1}})()`;

  // The rows hand-off: "}let Q=K,J;" becomes "}let Q=hasFolders?reorder(K):K,J;".
  const handOffStart = rows.match.index + rows.match[0].indexOf("}let ");
  const handOff = { index: handOffStart, Q: rows.match[1], J: rows.match[2] };

  // A folder row is a Working, Done, or pinned row only with this patch, so the
  // row component needs no flag: a folder row with one of their parents shows
  // its project icon, at full strength, in the place of the folder indent. The
  // icon's cache key also records the parent, because a thread that moves
  // between a section and its folder keeps the same row.
  const inSection = `([\`shelf:working\`,\`shelf:done\`,\`shelf:pinned\`].includes(${props}.navigationParent))`;
  const [cache, slot] = [icon.match[1], icon.match[2]];
  const a = flags.match[3];
  const iconParts = [
    [`${cache}[${slot}]!==${a}||`, `${cache}[${slot}]!==""+${a}+${inSection}||`],
    [`=${a}?null:`, `=${a}&&!${inSection}?null:`],
    [`(!${props}.isActive||`, `(!${props}.isActive&&!${a}||`],
    [`${cache}[${slot}]=${a},`, `${cache}[${slot}]=""+${a}+${inSection},`],
  ];
  let iconText = icon.match[0];
  for (const [from, to] of iconParts) {
    if (iconText.split(from).length !== 2) return unchanged("row icon: not read once");
    iconText = iconText.replace(from, () => to);
  }
  const indentFrom = `,${a}&&\`ps-9\`)`;
  const indentAt = indent.match.index + indent.match[0].length - indentFrom.length;

  const workingEdits = [
    // Show the Working section with the boring sidebar too.
    { start: gateStart, end: gateStart + gate.match[3].length, text: "" },
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
  ];

  const returnAt = returned.match.index + returned.match[0].lastIndexOf(",orderedThreadKeys:");
  const parentAt = parent.match.index + `navigationParent:${parent.match[1]}??(`.length;
  const doneEdits = [
    ...doneHooked.edits,
    ...doneListed.edits,
    { start: returnAt, end: returnAt, text: `,${DONE}` },
  ];

  // The sections whose rows look like the rows in the project folders.
  const plain = ["working", ...(sections.done ? ["done"] : []), ...(sections.pinned ? ["pinned"] : [])];
  const isPlain = plain.map((name) => `${look.match[3]}===\`${name}\``).join("||");

  const edits = [
    ...(sections.working ? workingEdits : []),
    ...(sections.done ? doneEdits : []),
    // The project icon in section rows.
    { start: icon.match.index, end: icon.match.index + icon.match[0].length, text: iconText },
    // No folder indent in section rows: the icon takes its place.
    { start: indentAt, end: indentEnd, text: `,${a}&&!${inSection}&&\`ps-9\`)` },
    // "let …,G=F!==null&&F.length>0,K;" also declares the flag.
    { start: declaredEnd, end: declaredEnd, text: `,${FOLDERS_FLAG}=${F}!==null` },
    // Working threads first in the keyboard order when there are folders, then
    // Done ones, of which there are none without folders.
    {
      start: keysStart,
      end: keys.match.index + keys.match[0].length,
      text:
        `=[...${folders.match[1]}!==null?${workingRows}:[],${sections.done ? `...${DONE}.rows,` : ""}` +
        `${keys.match[2]}...${folders.match[1]}!==null?[]:${workingRows},`,
    },
    {
      start: handOff.index,
      end: handOff.index + `}let ${handOff.Q}=${declared.match[2]},${handOff.J};`.length,
      text:
        `}let ${handOff.Q}=${hasFolders}?${REORDER}(${declared.match[2]},${sections.done ? `${DONE}.items` : "[]"})` +
        `:${declared.match[2]},${handOff.J};`,
    },
    // Section rows look like the rows in the project folders when there are
    // folders: "a=n?" becomes "a=n||hasFolders&&(t===`working`||…)?",
    {
      start: lookStart,
      end: lookStart + `=${look.match[2]}?`.length,
      text: `=${look.match[2]}||${hasFolders}&&(${isPlain})?`,
    },
    // and have their section as parent, for keyboard navigation and the icon.
    { start: parentAt, end: parentAt, text: `${hasFolders}&&(${isPlain})||` },
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
// paused request is answered once: patched when a section is on and the code
// is recognized, passed on unchanged otherwise.
function createWorkingShelfService({ send, sections, log = () => {} } = {}) {
  const logged = new Set();
  const logOnce = (message) => {
    if (logged.has(message)) return;
    logged.add(message);
    log(`Sidebar sections: ${message}`);
  };

  const isOn = (wanted) => wanted.working || wanted.done || wanted.pinned;

  // Interception stays on once enabled: turning the sections off makes every
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
      if (!isOn(sections()) || params.responseStatusCode !== 200 || params.responseErrorReason) return await pass();
      const body = await send("Fetch.getResponseBody", { requestId });
      const text = body.base64Encoded ? Buffer.from(body.body || "", "base64").toString("utf8") : body.body || "";
      // The switches may have changed while the body was read.
      const wanted = sections();
      if (!isOn(wanted)) return await pass();
      let result = patchSidebarChunk(text, wanted);
      // The rest goes on when a T3 Code update changes only what Done needs.
      if (!result.applied && wanted.done && (wanted.working || wanted.pinned)) {
        logOnce(`T3 Code's sidebar code was not recognized for Done (${result.problem})`);
        result = patchSidebarChunk(text, { ...wanted, done: false });
      }
      if (!result.applied) {
        logOnce(`T3 Code's sidebar code was not recognized (${result.problem})`);
        return await pass();
      }

      const responseHeaders = (params.responseHeaders || []).filter(
        (header) => !/^(content-length|content-encoding)$/i.test(header.name || ""),
      );
      await send("Fetch.fulfillRequest", {
        requestId,
        responseCode: params.responseStatusCode,
        responseHeaders,
        body: Buffer.from(result.source, "utf8").toString("base64"),
      });
      logOnce("changed in the boring sidebar");
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

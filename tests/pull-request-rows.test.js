"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ROW_GLOBAL, patchCardRows, patchMainRows, pullRequestRow } = require("../src/pull-request-rows");

const element = (type, props, key) => ({ type, props, key });
const react = { jsx: element, jsxs: element, Fragment: "fragment" };
const parts = {
  react,
  Row: "Row",
  rowClass: "group/pr-row flex",
  numberClass: "font-mono",
  Actor: "Actor",
  cn: (...names) => names.filter(Boolean).join(" "),
};
const LINE_CLASS = "group/pr-row flex px-2 hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

const LINK = {
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: 44191,
  url: "https://github.com/pingdotgg/t3code/pull/44191",
  linkedAt: "2026-11-27T12:56:47.907Z",
  snapshot: {
    state: "open",
    title: "fix(web): Word previews show documents with SVG pictures",
    updatedAt: "2026-11-27T12:38:35Z",
    author: { login: "only21mil", name: "Victor", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
  },
};

const propsFor = (overrides = {}) => ({
  link: LINK,
  fallbackIcon: "PullRequestIcon",
  tracker: { Icon: "GitHubIcon", providerName: "GitHub" },
  number: LINK.number,
  url: LINK.url,
  title: LINK.snapshot.title,
  presentation: { Icon: "OpenIcon", toneClassName: "stroke-green-600" },
  depth: 0,
  onOpenPullRequest: () => {},
  children: null,
  ...overrides,
});

const partsOf = (item) => {
  const line = item.props.children;
  const [icon, row] = line.props.children;
  const [author, provider, repository] = row.props.meta.props.children;
  return { line, icon, row, author, provider, repository };
};

test("a pull request in a badge's card is shown as an issue row: state icon, title and number, then author, provider, repository and time", () => {
  const item = pullRequestRow(parts)(propsFor(), "github.com/pingdotgg/t3code#44191");
  assert.equal(item.type, "li");
  assert.equal(item.key, "github.com/pingdotgg/t3code#44191");
  assert.deepEqual(item.props.style, { paddingInlineStart: "0rem" });
  const { line, icon, row, author, provider, repository } = partsOf(item);
  assert.equal(line.type, "a");
  assert.equal(line.props.href, LINK.url);
  assert.equal(line.props.className, LINE_CLASS);
  assert.equal(icon.type, "OpenIcon");
  assert.equal(icon.props.className, "size-4 shrink-0 stroke-green-600");
  assert.equal(row.type, "Row");
  assert.deepEqual(row.props.number, element("span", { className: "font-mono", children: "#44191" }));
  assert.equal(row.props.title, LINK.snapshot.title);
  assert.equal(row.props.updatedAt, LINK.snapshot.updatedAt);
  assert.deepEqual(author, element("Actor", { actor: LINK.snapshot.author, tooltip: false }));
  assert.deepEqual(provider, element("GitHubIcon", { role: "img", "aria-label": "GitHub", className: "size-3 shrink-0" }));
  assert.deepEqual(repository, element("span", { className: "truncate", children: "pingdotgg/t3code" }));
});

test("a row opens its pull request the way T3 Code's row does, and keeps a stack's label and indent", () => {
  const opened = [];
  const stack = element("span", { children: "stack · 3" });
  const item = pullRequestRow(parts)(propsFor({ depth: 5, children: stack, onOpenPullRequest: (event, url) => opened.push([event.type, url]) }), "k");
  assert.deepEqual(item.props.style, { paddingInlineStart: "2.25rem" });
  const { line, row } = partsOf(item);
  let stopped = false;
  line.props.onPointerDown({ stopPropagation: () => (stopped = true) });
  line.props.onClick({ type: "click" });
  assert.equal(stopped, true);
  assert.deepEqual(opened, [["click", LINK.url]]);
  assert.equal(row.props.status, stack);
});

test("a linked pull request without a snapshot is an issue row too, with T3 Code's pull request icon and the time it was linked", () => {
  const item = pullRequestRow(parts)(propsFor({ link: { ...LINK, snapshot: null }, presentation: null, title: LINK.repository }), "k");
  const { icon, row, author } = partsOf(item);
  assert.equal(icon.type, "PullRequestIcon");
  assert.equal(icon.props.className, "size-4 shrink-0 stroke-muted-foreground");
  assert.equal(row.props.title, LINK.repository);
  assert.equal(row.props.updatedAt, LINK.linkedAt);
  assert.equal(author, null);
});

test("lists whose rows do not open, such as a thread's hover card, keep T3 Code's own line", () => {
  const render = pullRequestRow(parts);
  assert.equal(render(propsFor({ onOpenPullRequest: undefined }), "k"), undefined);
  assert.equal(render(propsFor({ link: undefined }), "k"), undefined);
  assert.equal(render(propsFor({ presentation: null, fallbackIcon: undefined }), "k"), undefined);
});

const MAIN = [
  "var $={jsx:(t,p,k)=>({t,p,k}),jsxs:(t,p,k)=>({t,p,k}),Fragment:`f`};",
  "function Uc(){}function Fp(){};var Gc=`group/pr-row`,Hc=`font-mono`;function ur(...c){return c.filter(Boolean).join(` `)}",
  "function AV(n,l,v,S,O,k){let T=(0,$.jsx)(`span`,{className:Hc,children:n.displayKey});",
  "let E=l?.author?(0,$.jsx)(Fp,{actor:l.author,tooltip:!1}):null;let A=(0,$.jsx)(Uc,{number:T,title:v,status:S,meta:O,updatedAt:k});",
  "return(0,$.jsx)(`a`,{className:ur(Gc,`px-2 hover:bg-accent/60 focus-visible:outline-2`),children:A})}",
  "export{AV as a};",
  "//# sourceMappingURL=main-a.js.map",
].join("\n");

test("the main script gets a pull request row built from T3 Code's issue row parts", () => {
  const result = patchMainRows(MAIN);
  assert.equal(result.applied, true, result.problem);
  const exportAt = result.source.indexOf("export{");
  assert.ok(result.source.indexOf(`globalThis.${ROW_GLOBAL}=`) < exportAt);
  delete globalThis[ROW_GLOBAL];
  new Function(result.source.slice(0, exportAt))();
  try {
    const item = globalThis[ROW_GLOBAL](propsFor(), "k");
    assert.equal(item.t, "li");
    const line = item.p.children;
    const [icon, row] = line.p.children;
    assert.equal(icon.t, "OpenIcon");
    assert.equal(row.p.number.p.className, "font-mono");
    assert.equal(row.p.meta.p.children[1].t, "GitHubIcon");
    assert.equal(line.p.className, "group/pr-row px-2 hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring");
  } finally {
    delete globalThis[ROW_GLOBAL];
  }
});

test("the main script is left as it is when a part is missing", () => {
  for (const broken of [MAIN.replace("tooltip:!1", "tooltip:!0"), MAIN.replace("export{AV as a};", "")]) {
    const refused = patchMainRows(broken);
    assert.equal(refused.applied, false);
    assert.equal(refused.source, broken);
  }
});

test("a part that T3 Code keeps inside the issue row still lets the script load, and the card keeps T3 Code's own line", () => {
  const local = MAIN.replace(";var Gc=`group/pr-row`,Hc=`font-mono`;", ";var Gc=`group/pr-row`;").replace("function AV(n,l,v,S,O,k){", "function AV(n,l,v,S,O,k){let Hc=`font-mono`;");
  const result = patchMainRows(local);
  assert.equal(result.applied, true, result.problem);
  delete globalThis[ROW_GLOBAL];
  new Function(result.source.slice(0, result.source.indexOf("export{")))();
  try {
    assert.equal(globalThis[ROW_GLOBAL](propsFor(), "k"), undefined);
  } finally {
    delete globalThis[ROW_GLOBAL];
  }
});

const CARD = [
  "var b={findByChangeRequestUrl:(u)=>u.includes(`github`)?{kind:`github`}:null,get:()=>({kind:`git`}),find:(k)=>k===`github`?{}:void 0},ir={},le=`Generic`,K={pullRequest:`PullRequestIcon`};",
  "function Tt(e){return{Icon:`GitHubIcon`,providerName:`GitHub`}}",
  "function ar(e){return b.find(e)===void 0?ir[e]??{providerName:e,Icon:le}:Tt(e)}",
  "function Zt(e){return((e===void 0?null:b.findByChangeRequestUrl(e))??b.get(void 0)).changeRequest}",
  "function dn(e){let{presentation:a}=e,u=a?.Icon??K.pullRequest,d=1;return u}",
  "function un(n,r,dn,Y){return n.map(e=>{let t=e.link.snapshot,p=t===null?null:{Icon:`i`};",
  "return(0,Y.jsx)(dn,{number:e.link.number,url:e.link.url,title:t?.title??e.link.repository,presentation:p,depth:e.depth,onOpenPullRequest:r,children:null},`${e.link.host}#${e.link.number}`)})}",
].join("\n");

test("the card uses the pull request row while the main script provides it, and T3 Code's row otherwise", () => {
  const result = patchCardRows(CARD);
  assert.equal(result.applied, true, result.problem);
  const un = new Function(`${result.source}\nreturn un;`)();
  const Y = { jsx: (type, props, key) => ({ native: type, props, key }) };
  const entries = [{ link: LINK, depth: 0 }];
  delete globalThis[ROW_GLOBAL];
  const [native] = un(entries, "open", "dn", Y);
  assert.equal(native.native, "dn");
  assert.equal(native.key, "github.com#44191");
  assert.equal(native.props.link, LINK);
  assert.equal(native.props.fallbackIcon, "PullRequestIcon");
  assert.deepEqual(native.props.tracker, { Icon: "GitHubIcon", providerName: "GitHub" });
  assert.equal(native.props.title, LINK.snapshot.title);
  const elsewhere = un([{ link: { ...LINK, url: "https://code.example.com/x/y/pulls/1" }, depth: 0 }], "open", "dn", Y)[0];
  assert.deepEqual(elsewhere.props.tracker, { providerName: "git", Icon: "Generic" });
  globalThis[ROW_GLOBAL] = (props, key) => ({ ours: props.link.number, key });
  try {
    assert.deepEqual(un(entries, "open", "dn", Y), [{ ours: 44191, key: "github.com#44191" }]);
    globalThis[ROW_GLOBAL] = () => undefined;
    assert.equal(un(entries, "open", "dn", Y)[0].native, "dn");
  } finally {
    delete globalThis[ROW_GLOBAL];
  }
  assert.equal(patchCardRows(result.source).applied, false);
  for (const broken of ["let x=1;", CARD.replace("??K.pullRequest,", "??K.pr,"), CARD.replace(".changeRequest}", ".request}")]) {
    assert.equal(patchCardRows(broken).applied, false);
  }
});

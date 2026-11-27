"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ROW_GLOBAL, patchCardRows, patchMainRows, pullRequestRow } = require("../src/pull-request-rows");

const element = (type, props, key) => ({ type, props, key });
const react = { jsx: element, jsxs: element, Fragment: "fragment" };
const Row = "Row";
const Actor = "Actor";
const GitHubIcon = "GitHubIcon";
const OpenIcon = "OpenIcon";
const parts = {
  react,
  Row,
  rowClass: "group/pr-row flex",
  numberClass: "font-mono",
  Actor,
  provider: (kind) => ({ Icon: kind === "github" ? GitHubIcon : "OtherIcon", providerName: kind }),
  cn: (...names) => names.filter(Boolean).join(" "),
};

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
  number: LINK.number,
  url: LINK.url,
  title: LINK.snapshot.title,
  presentation: { Icon: OpenIcon, toneClassName: "stroke-green-600" },
  depth: 0,
  onOpenPullRequest: () => {},
  children: null,
  ...overrides,
});

test("a linked pull request is shown as an issue row: state icon, title and number, then author, provider, repository and time", () => {
  const item = pullRequestRow(parts)(propsFor(), "github.com/pingdotgg/t3code#44191");
  assert.equal(item.type, "li");
  assert.equal(item.key, "github.com/pingdotgg/t3code#44191");
  assert.deepEqual(item.props.style, { paddingInlineStart: "0rem" });
  const line = item.props.children;
  assert.equal(line.type, "a");
  assert.equal(line.props.href, LINK.url);
  assert.equal(line.props.className, "group/pr-row flex px-2 hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring");
  const [icon, row] = line.props.children;
  assert.equal(icon.type, OpenIcon);
  assert.equal(icon.props.className, "size-4 shrink-0 stroke-green-600");
  assert.equal(row.type, Row);
  assert.deepEqual(row.props.number, element("span", { className: "font-mono", children: "#44191" }));
  assert.equal(row.props.title, LINK.snapshot.title);
  assert.equal(row.props.updatedAt, LINK.snapshot.updatedAt);
  const [author, provider, repository] = row.props.meta.props.children;
  assert.deepEqual(author, element(Actor, { actor: LINK.snapshot.author, tooltip: false }));
  assert.equal(provider.type, GitHubIcon);
  assert.deepEqual(repository, element("span", { className: "truncate", children: "pingdotgg/t3code" }));
});

test("a row opens its pull request the way T3 Code's row does, and keeps a stack's label and indent", () => {
  const opened = [];
  const stack = element("span", { children: "stack · 3" });
  const item = pullRequestRow(parts)(propsFor({ depth: 5, children: stack, onOpenPullRequest: (event, url) => opened.push([event.type, url]) }), "k");
  assert.deepEqual(item.props.style, { paddingInlineStart: "2.25rem" });
  const line = item.props.children;
  let stopped = false;
  line.props.onPointerDown({ stopPropagation: () => (stopped = true) });
  line.props.onClick({ type: "click" });
  assert.equal(stopped, true);
  assert.deepEqual(opened, [["click", LINK.url]]);
  assert.equal(line.props.children[1].props.status, stack);

  const still = pullRequestRow(parts)(propsFor({ onOpenPullRequest: undefined }), "k").props.children;
  assert.equal(still.type, "div");
  assert.equal(still.props.href, undefined);
  assert.equal(still.props.className, "group/pr-row flex px-2");
});

test("a row without a snapshot or a state keeps T3 Code's own row, and the time falls back to when it was linked", () => {
  const render = pullRequestRow(parts);
  assert.equal(render(propsFor({ link: { ...LINK, snapshot: null } }), "k"), undefined);
  assert.equal(render(propsFor({ presentation: null }), "k"), undefined);
  const noTime = render(propsFor({ link: { ...LINK, snapshot: { ...LINK.snapshot, updatedAt: undefined, author: null } } }), "k");
  const row = noTime.props.children.props.children[1];
  assert.equal(row.props.updatedAt, LINK.linkedAt);
  assert.equal(row.props.meta.props.children[0], null);
  const gitlab = render(propsFor({ link: { ...LINK, host: "gitlab.example.com" } }), "k").props.children.props.children[1];
  assert.equal(gitlab.props.meta.props.children[1].type, "OtherIcon");
  const enterprise = render(propsFor({ link: { ...LINK, host: "acme.ghe.com" } }), "k").props.children.props.children[1];
  assert.equal(enterprise.props.meta.props.children[1].type, GitHubIcon);
});

const MAIN = [
  "const $={jsx:(t,p,k)=>({t,p,k}),jsxs:(t,p,k)=>({t,p,k}),Fragment:`f`};",
  "function Uc(){}function Fp(){}const Gc=`group/pr-row`,Hc=`font-mono`,ur=(...c)=>c.filter(Boolean).join(` `),ov=(k)=>({Icon:k,providerName:k});",
  "function AV(n,l,v,S,O,k){let d=ov(n.tracker);let T=(0,$.jsx)(`span`,{className:Hc,children:n.displayKey});",
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
    const [icon, row] = item.p.children.p.children;
    assert.equal(icon.t, OpenIcon);
    assert.equal(row.p.number.p.className, "font-mono");
    assert.equal(row.p.meta.p.children[1].t, "github");
    assert.equal(item.p.children.p.className, "group/pr-row px-2 hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring");
  } finally {
    delete globalThis[ROW_GLOBAL];
  }
  for (const broken of [MAIN.replace("tooltip:!1", "tooltip:!0"), MAIN.replace("export{AV as a};", "")]) {
    const refused = patchMainRows(broken);
    assert.equal(refused.applied, false);
    assert.equal(refused.source, broken);
  }
});

const CARD =
  "function un(n,r,dn,Y){return n.map(e=>{let t=e.link.snapshot,p=t===null?null:{Icon:`i`};" +
  "return(0,Y.jsx)(dn,{number:e.link.number,url:e.link.url,title:t?.title??e.link.repository,presentation:p,depth:e.depth,onOpenPullRequest:r,children:null},`${e.link.host}#${e.link.number}`)})}";

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
  assert.equal(native.props.title, LINK.snapshot.title);
  globalThis[ROW_GLOBAL] = (props, key) => ({ ours: props.link.number, key });
  try {
    assert.deepEqual(un(entries, "open", "dn", Y), [{ ours: 44191, key: "github.com#44191" }]);
    globalThis[ROW_GLOBAL] = () => undefined;
    assert.equal(un(entries, "open", "dn", Y)[0].native, "dn");
  } finally {
    delete globalThis[ROW_GLOBAL];
  }
  assert.equal(patchCardRows(result.source).applied, false);
  assert.equal(patchCardRows("let x=1;").applied, false);
});

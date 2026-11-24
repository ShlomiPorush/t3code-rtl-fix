"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ROUTE_URL, ROUTE_URL_PATTERN, patchHomeRoute } = require("../src/home-route");
const { FRESH_MS, LANES, createHomeGithub, readAnswer, readRequest, stageOf } = require("../src/home-github");
const { createWorkingShelfService, URL_PATTERN } = require("../src/working-shelf");
const { createExtrasService } = require("../src/extras");
const { HOME_CSS, homeView } = require("../src/home-view");

// A small stand-in for T3 Code's start route, with every place the patch reads
// written the way T3 Code 0.1.11 minifies it.
const ROUTE = [
  'import{i as e}from"./rolldown-runtime-A.js";import{t}from"./react-B.js";import{n,t as r}from"./jsx-C.js";import{mi as c}from"./utils-D.js";' +
    'import{a as m}from"./useParams-E.js";import{H as g,h as _,o as v,w as y}from"./entities-F.js";import{I as S}from"./useSettings-G.js";' +
    'import{l as w}from"./workspaceFocus-H.js";import{o}from"./dist-I.js";import{o as E}from"./sidebar-J.js";import{H as I}from"./Sidebar.logic-K.js";' +
    'import{s as L}from"./useHandleNewThread-L.js";import{et as R,m as z}from"./main-Dfw4_UIy.js";import{t as B}from"./WorkspacePageHeader-M.js";' +
    'import{t as V}from"./NoProjectsHero-N.js";var H=e(t(),1),U=n(),W=e(r(),1);',
  "function K(){return 1}",
  "function ee(){let e=(0,U.c)(2),{authGateState:t}=z.useRouteContext(),{environments:n,isReady:r}=S();if(t.status===`hosted-static`){if(!r)return null}" +
    "let i;return e[1]===Symbol.for(`x`)?(i=(0,W.jsx)(te,{}),e[1]=i):i=e[1],i}",
  "function te(){let e=(0,U.c)(19),t=y(),n=g(),r=_(),i=L(),a=m(),s;s=()=>a.state.location.pathname===`/`;let c=(0,H.useEffectEvent)(s),l=(0,H.useRef)(null),p;" +
    "p=I(t.filter(ae),n,`updated_at`)[0]??null;let h=p,x=()=>{if(h===null||!c())return;let e=o(h.environmentId,h.id);v(e)!==null&&(i(e,{replace:!0}).then(e=>{e}).catch(()=>{}))};" +
    "(0,H.useEffect)(x,[]);let C;return C=r?(0,W.jsx)(V,{}):null,C}",
  "function ae(e){return e.archivedAt==null}",
  "function oe(e){let r=1,o=w(`home`,1,r),l=o,u=c?(0,W.jsx)(B,{electron:!0}):null,_;return _=(0,W.jsxs)(E,{...l,role:`main`,className:`h-dvh min-h-0`,children:[u,1]}),_}",
  "export{ee as component};\n//# sourceMappingURL=_chat.index-X.js.map",
].join("");

test("the route shows Home in place of the component that forwards to a draft, which stays as it was", () => {
  const { applied, source, problem } = patchHomeRoute(ROUTE);
  assert.equal(applied, true, problem);
  assert.ok(source.includes("(i=(0,W.jsx)(t3RtlHome$,{native:te}),e[1]=i)"));
  const forward = ROUTE.slice(ROUTE.indexOf("function te("), ROUTE.indexOf("function ae("));
  assert.ok(source.includes(forward));
  assert.ok(source.includes('import*as t3RtlHomeMain$ from"./main-Dfw4_UIy.js";'));
  assert.ok(
    source.includes(
      "({React:H,useProjects:y,useThreads:g,useBootstrapped:_,useNewThread:L,useRouter:m,useEnvironments:S," +
        'projectReference:o,Frame:E,focusProps:w,Header:B,electron:c,main:t3RtlHomeMain$,frameClass:"h-dvh min-h-0",',
    ),
  );
  assert.ok(source.endsWith("export{ee as component};\n//# sourceMappingURL=_chat.index-X.js.map"));
});

test("a route that is not recognized is passed on byte for byte", () => {
  const sites = [
    ".state.location.pathname===`/`",
    "I(t.filter(ae),n,`updated_at`)[0]",
    "i(e,{replace:!0}).then(",
    "let e=o(h.environmentId,h.id)",
    "C=r?(0,W.jsx)(V,{}):null",
    "(0,H.useEffectEvent)",
    "(0,W.jsxs)(E,{...l,role:`main`,className:`h-dvh min-h-0`",
    "u=c?(0,W.jsx)(B,{electron:!0}):null",
    "(0,W.jsx)(te,{})",
    "{environments:n,isReady:r}=S()",
    "o=w(`home`,1,",
    'from"./main-Dfw4_UIy.js"',
    "export{ee as component}",
  ];
  for (const site of sites) {
    assert.equal(ROUTE.split(site).length, 2, site);
    const missing = ROUTE.replace(site, () => "0");
    assert.deepEqual({ ...patchHomeRoute(missing), problem: "" }, { applied: false, source: missing, problem: "" }, `without ${site}`);
  }
  for (const site of ["(0,W.jsx)(te,{})", "u=c?(0,W.jsx)(B,{electron:!0}):null", "i(e,{replace:!0}).then("]) {
    const doubled = ROUTE.replace(site, () => `${site};${site}`);
    assert.equal(patchHomeRoute(doubled).applied, false, `twice ${site}`);
  }
  assert.equal(patchHomeRoute(ROUTE.replace("L as", "").replace("{s as L}", "{s as Q}")).applied, false, "a hook of another module");
  assert.equal(patchHomeRoute(patchHomeRoute(ROUTE).source).applied, false, "already changed");
  assert.equal(patchHomeRoute("export{a as component};").applied, false);
});

const paused = (url, overrides = {}) => ({ requestId: "r1", request: { url }, responseStatusCode: 200, responseHeaders: [], ...overrides });
const ROUTE_ADDRESS = "t3code://app/assets/_chat.index-B3kyQwF1.js";

function connection(body) {
  const calls = [];
  const gate = {};
  const send = async (method, params) => {
    calls.push({ method, params });
    if (method === "Fetch.getResponseBody") {
      if (gate.hold) await gate.hold;
      return { body: Buffer.from(body, "utf8").toString("base64"), base64Encoded: true };
    }
    return {};
  };
  return { calls, gate, send, methods: () => calls.map((call) => call.method) };
}

test("one watch covers T3 Code's main script and its start route", async () => {
  const { calls, send } = connection("");
  await createWorkingShelfService({ send, sections: () => ({}), home: () => true }).enable();
  assert.deepEqual(calls[0].params.patterns.map((pattern) => pattern.urlPattern), [URL_PATTERN, ROUTE_URL_PATTERN]);
  assert.match(ROUTE_ADDRESS, ROUTE_URL);
  assert.doesNotMatch("t3code://app/assets/_chat.index-a/evil.js", ROUTE_URL);
});

test("each script follows its own switch, and the other passes without being read", async () => {
  const none = { working: false, done: false, pinned: false };
  const home = connection(ROUTE);
  await createWorkingShelfService({ send: home.send, sections: () => none, home: () => true }).handlePaused(paused(ROUTE_ADDRESS));
  assert.deepEqual(home.methods(), ["Fetch.getResponseBody", "Fetch.fulfillRequest"]);
  assert.equal(Buffer.from(home.calls[1].params.body, "base64").toString("utf8"), patchHomeRoute(ROUTE).source);

  const main = connection(ROUTE);
  await createWorkingShelfService({ send: main.send, sections: () => none, home: () => true }).handlePaused(paused("t3code://app/assets/main-a.js"));
  assert.deepEqual(main.methods(), ["Fetch.continueRequest"]);

  const off = connection(ROUTE);
  await createWorkingShelfService({ send: off.send, sections: () => ({ working: true }), home: () => false }).handlePaused(paused(ROUTE_ADDRESS));
  assert.deepEqual(off.methods(), ["Fetch.continueRequest"]);
});

test("Home turned off while the route is read passes the route unchanged, and an unknown route is logged", async () => {
  const held = connection(ROUTE);
  let release;
  held.gate.hold = new Promise((resolve) => (release = resolve));
  let home = true;
  const handled = createWorkingShelfService({ send: held.send, sections: () => ({}), home: () => home }).handlePaused(paused(ROUTE_ADDRESS));
  await new Promise((resolve) => setImmediate(resolve));
  home = false;
  release();
  await handled;
  assert.deepEqual(held.methods(), ["Fetch.getResponseBody", "Fetch.continueRequest"]);

  const logs = [];
  const unknown = connection("export{a as component};");
  await createWorkingShelfService({ send: unknown.send, sections: () => ({}), home: () => true, log: (line) => logs.push(line) }).handlePaused(paused(ROUTE_ADDRESS));
  assert.deepEqual(unknown.methods(), ["Fetch.getResponseBody", "Fetch.continueRequest"]);
  assert.match(logs.join("\n"), /start page code was not recognized/);
});

test("a request names repositories only", () => {
  assert.deepEqual(readRequest(["Owner/Repo", "owner/repo", "a_b/c.d"]), ["owner/repo", "a_b/c.d"]);
  for (const bad of [null, "a/b", [1], ["a"], ["a/b/c"], ["a/.."], ["a/b\"){x}"], ["a b/c"], ["-"]]) {
    assert.equal(readRequest(bad), null, JSON.stringify(bad)?.slice(0, 40));
  }
});

test("a failed check is said before a conflict, a conflict before a draft, and only a clean one is ready", () => {
  const clean = { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", isDraft: false };
  const cases = [
    [{ ...clean, isDraft: true, mergeable: "CONFLICTING" }, "FAILURE", "open", "bad", "check failed"],
    [clean, "ERROR", "open", "bad", "check failed"],
    [{ ...clean, isDraft: true, mergeable: "CONFLICTING" }, "SUCCESS", "open", "warn", "conflicts"],
    [{ ...clean, mergeable: "UNKNOWN", mergeStateStatus: "DIRTY" }, "PENDING", "open", "warn", "conflicts"],
    [{ ...clean, isDraft: true }, "PENDING", "open", "", "draft"],
    [clean, "PENDING", "open", "", "checks running"],
    [clean, "EXPECTED", "open", "", "checks running"],
    [clean, "SUCCESS", "ready", "ok", ""],
    [clean, null, "ready", "ok", "no checks"],
    [{ ...clean, mergeStateStatus: "BLOCKED" }, "SUCCESS", "open", "", "blocked by the branch rules"],
    [{ ...clean, mergeStateStatus: "BEHIND" }, "SUCCESS", "open", "", "behind the base branch"],
    [{ ...clean, mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN" }, "SUCCESS", "open", "", "merge state unknown"],
  ];
  for (const [pull, checks, stage, tone, note] of cases) assert.deepEqual(stageOf(pull, checks), { stage, tone, note });
});

const pull = (number, login = "someone") => ({
  number, title: `Title ${number}`, isDraft: false, updatedAt: "2026-11-24T00:00:00Z", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
  author: { login }, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
});
const repository = (overrides = {}) => ({
  issues: { totalCount: 3 },
  pullRequests: { pageInfo: { hasNextPage: false }, nodes: [pull(7)] },
  latestRelease: { tagName: "v1", publishedAt: "2026-11-23T00:00:00Z", tag: { compare: { aheadBy: 2 } } },
  defaultBranchRef: { target: { statusCheckRollup: { state: "SUCCESS" } } },
  ...overrides,
});
const answer = (node, errors) => JSON.stringify({ data: { repository: node }, ...(errors ? { errors } : {}) });

test("an answer tells apart what is absent, what is unknown, and what is cut", () => {
  const read = readAnswer(answer(repository()));
  assert.equal(read.failedField, false);
  assert.equal(read.cut, false);
  assert.equal(read.issues, 3);
  assert.deepEqual(read.release, { tag: "v1", at: Date.parse("2026-11-23T00:00:00Z"), ahead: 2 });
  assert.equal(read.pulls[0].number, 7);

  assert.equal(readAnswer(answer(repository({ latestRelease: null }))).release, null);
  const failed = readAnswer(answer(repository({ latestRelease: null }), [{ path: ["repository", "latestRelease"] }]));
  assert.equal(failed.release, undefined);
  assert.equal(failed.failedField, true);
  assert.equal(failed.cut, false);
  assert.equal(readAnswer(answer(repository({ latestRelease: { tagName: "v1", tag: null } }))).release.ahead, null);
  assert.equal(readAnswer(answer(repository({ pullRequests: { pageInfo: { hasNextPage: true }, nodes: [pull(1)] } }))).cut, true);
  const lost = readAnswer(answer(repository({ pullRequests: { pageInfo: { hasNextPage: false }, nodes: [pull(1), null] } }), [{ path: ["repository", "pullRequests", "nodes", 1] }]));
  assert.deepEqual([lost.cut, lost.failedField], [false, true]);
  assert.equal(readAnswer(answer(repository({ defaultBranchRef: { target: { statusCheckRollup: { state: "FAILURE" } } } }))).mainFails, true);
  assert.equal(readAnswer(answer(null, [{ type: "NOT_FOUND" }])), null);
  assert.equal(readAnswer("<html>"), null);
});

test("dependency updates are known by their author alone", () => {
  const logins = ["dependabot", "dependabot[bot]", "renovate", "renovate[bot]", "t3-code-bot", "github-actions"];
  const nodes = logins.map((login, index) => pull(index + 1, login));
  const read = readAnswer(answer(repository({ pullRequests: { pageInfo: { hasNextPage: false }, nodes } })));
  assert.deepEqual(read.pulls.map((item) => item.update), [true, true, true, true, false, false]);
});

function github({ answers = () => answer(repository()) } = {}) {
  const calls = [];
  let time = 1e6;
  let active = 0;
  let most = 0;
  const run = async (file, args) => {
    const owner = args.find((arg) => arg.startsWith("owner=")).slice(6);
    const name = args.find((arg) => arg.startsWith("name=")).slice(5);
    calls.push({ file, args, name: `${owner}/${name}` });
    most = Math.max(most, (active += 1));
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    const result = answers(`${owner}/${name}`);
    return typeof result === "string" ? { stdout: result, stderr: "", error: null } : result;
  };
  const service = createHomeGithub({ run, now: () => time });
  return { calls, service, most: () => most, pass: (ms) => (time += ms) };
}
const settle = async () => {
  for (let i = 0; i < 60; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("a request is answered at once, and again as each repository is read", async () => {
  const { calls, service, most } = github();
  const names = Array.from({ length: 10 }, (_, index) => `o/r${index}`);
  const got = [];
  service.read("window", names, (facts) => got.push(facts));
  assert.deepEqual(got[0].repositories["o/r0"], { status: "waiting" });
  await settle();
  assert.equal(calls.length, 10);
  assert.equal(most(), LANES);
  assert.equal(got.length, 11);
  assert.equal(got.at(-1).problem, null);
  assert.ok(names.every((name) => got.at(-1).repositories[name].status === "read"));
  assert.ok(calls.every((call) => call.file === "gh" && call.args.join(" ").includes("--hostname github.com")));
});

test("facts are read again only when they are old, for every window together, failures included", async () => {
  const { calls, service, pass } = github({ answers: (name) => (name === "o/bad" ? answer(null) : answer(repository())) });
  const read = (key, names) => {
    const got = [];
    service.read(key, names, (facts) => got.push(facts));
    return got;
  };
  read("a", ["o/one", "o/bad"]);
  const second = read("b", ["o/one", "o/two"]);
  await settle();
  assert.deepEqual(calls.map((call) => call.name).sort(), ["o/bad", "o/one", "o/two"]);
  assert.equal(second.at(-1).repositories["o/two"].status, "read");
  assert.equal("o/bad" in second.at(-1).repositories, false, "a window gets only what it asked for");
  const cached = read("a", ["o/one", "o/bad"]);
  await settle();
  assert.equal(calls.length, 3);
  assert.equal(cached.length, 1);
  assert.equal(cached[0].repositories["o/bad"].status, "unavailable");
  pass(FRESH_MS);
  read("a", ["o/one"]);
  await settle();
  assert.equal(calls.length, 4);
});

test("facts from before a failed read stay, marked as old, and one failure is not a problem of all", async () => {
  let broken = false;
  const missing = { stdout: "", stderr: "", error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) };
  const { service, pass } = github({ answers: (name) => (broken && (broken === "all" || name === broken) ? missing : answer(repository())) });
  const read = async (names) => {
    const got = [];
    service.read("a", names, (facts) => got.push(facts));
    await settle();
    return got.at(-1);
  };
  await read(["o/one", "o/two"]);
  broken = "o/one";
  pass(FRESH_MS);
  const one = await read(["o/one", "o/two"]);
  assert.equal(one.problem, null);
  assert.equal(one.repositories["o/one"].stale, true);
  assert.equal(one.repositories["o/one"].readAt, 1e6);
  assert.equal(one.repositories["o/two"].stale, false);
  broken = "all";
  pass(FRESH_MS);
  assert.equal((await read(["o/one", "o/two"])).problem, "gh-missing");
});

function extras({ homePage = true } = {}) {
  const asked = [];
  const evaluated = [];
  const service = createExtrasService({
    send: async (method, params) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") return { executionContextId: 5 };
      if (method === "Runtime.evaluate") evaluated.push(params.expression);
      return { result: { value: true } };
    },
    store: { get: () => ({ homePage }), reload() {}, change: async () => ({ ok: true }) },
    reader: { read: async () => ({ accounts: [], problem: null }) },
    homeGithub: { read: (key, names, deliver) => (asked.push([key, names]), deliver({ problem: null, repositories: {} })) },
  });
  return { asked, evaluated, service };
}

test("only the fix's own world can ask, only for repositories, and only while Home is on", async () => {
  const on = extras();
  await on.service.attach("s");
  const message = JSON.stringify({ type: "home", repositories: ["o/r"] });
  await on.service.handle("s", 6, message);
  await on.service.handle("s", 5, JSON.stringify({ type: "home", repositories: ["o/r x"] }));
  assert.deepEqual(on.asked, []);
  await on.service.handle("s", 5, message);
  assert.deepEqual(on.asked, [["s", ["o/r"]]]);
  assert.match(on.evaluated.at(-1), /"kind":"home"/);

  const off = extras({ homePage: false });
  await off.service.attach("s");
  await off.service.handle("s", 5, message);
  assert.deepEqual(off.asked, []);
});

test("a list of many repositories fits, and other messages keep their small limit", async () => {
  const { asked, service } = extras();
  await service.attach("s");
  const names = Array.from({ length: 120 }, (_, index) => `an-owner/a-repository-with-a-name-${index}`);
  await service.handle("s", 5, JSON.stringify({ type: "home", repositories: names }));
  assert.equal(asked[0][1].length, 120);
  await service.handle("s", 5, JSON.stringify({ type: "home", repositories: names, filler: "x".repeat(40 * 1024) }));
  assert.equal(asked.length, 1);
});

// Just enough of React to render the component to text: state keeps its first
// value, and effects do not run.
function renderHome({ projects = [], threads = [], bootstrapped = true, connected = ["local"], search = {}, github = null, fail = false } = {}) {
  const calls = [];
  const React = {
    Component: class { constructor(props) { this.props = props; } },
    createElement: (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? { children: children.length > 1 ? children : children[0] } : {}) } }),
    useState: (first) => [typeof first === "function" ? first() : first ?? github, () => {}],
    useEffect() {},
    useRef: (current) => ({ current }),
    useCallback: (fn) => fn,
    useSyncExternalStore: (subscribe, read) => read(),
  };
  const Home = homeView({
    React,
    useProjects: () => projects,
    useThreads: () => {
      if (fail) throw new Error("another shape");
      return threads;
    },
    useBootstrapped: () => bootstrapped,
    useNewThread: () => (reference) => {
      calls.push(["new", reference]);
      return Promise.resolve({});
    },
    useRouter: () => ({ state: { location: { search } }, navigate: (to) => calls.push(["go", to]) }),
    useEnvironments: () => ({ environments: connected.map((environmentId) => ({ environmentId, connection: { phase: "connected" } })) }),
    projectReference: (environmentId, projectId) => ({ environmentId, projectId }),
    Frame: ({ children }) => children, focusProps: () => ({}), Header: ({ children }) => children, electron: true, main: {}, frameClass: "", css: "",
  });
  const buttons = [];
  const links = [];
  const text = (node) => {
    if (node == null || node === false || node === true) return "";
    if (Array.isArray(node)) return node.map(text).join("");
    if (typeof node !== "object") return String(node);
    const { type, props } = node;
    if (typeof type === "function") {
      if (!(type.prototype instanceof React.Component)) return text(type(props));
      const instance = new type(props);
      try {
        return text(instance.render());
      } catch (error) {
        instance.state = type.getDerivedStateFromError(error);
        return text(instance.render());
      }
    }
    const inner = text(props.children);
    if (type === "button") buttons.push({ name: inner || props["aria-label"], label: props["aria-label"], click: props.onClick });
    if (type === "a") links.push({ name: inner, href: props.href });
    return inner + (type === "span" ? "" : "\n");
  };
  const shown = text(React.createElement(Home, { native: () => "T3 Code's own page" }));
  return { shown, buttons, links, calls };
}

const project = (id, repository, environmentId = "local") => ({
  id, environmentId, title: id, archivedAt: null, ...(repository ? { repositoryIdentity: { canonicalKey: `github.com/${repository}` } } : {}),
});
const thread = (overrides = {}) => ({
  id: "t1", environmentId: "local", projectId: "app", title: "A thread", updatedAt: "2026-11-24T10:00:00Z", archivedAt: null,
  runtime: { status: "running" }, lineage: { relationshipToParent: null }, hasPendingApprovals: false, hasPendingUserInput: false, ...overrides,
});
const facts = (overrides = {}) => ({ status: "read", readAt: 1, stale: false, pulls: [], issues: 0, release: null, mainFails: false, failedField: false, cut: false, ...overrides });

test("T3 Code's own page shows only with no projects after they all loaded, and when Home fails", () => {
  assert.equal(renderHome({ bootstrapped: false }).shown, "");
  assert.equal(renderHome({ bootstrapped: true }).shown, "T3 Code's own page");
  assert.equal(renderHome({ projects: [{ ...project("old"), archivedAt: "2026-01-01" }] }).shown, "T3 Code's own page");
  assert.match(renderHome({ projects: [project("app")], bootstrapped: false }).shown, /Not on GitHub/);
  const silenced = console.error;
  console.error = () => {};
  try {
    assert.equal(renderHome({ projects: [project("app")], fail: true }).shown, "T3 Code's own page");
  } finally {
    console.error = silenced;
  }
});

test("an agent counts as working only while it runs, in a connected computer, and not as a part of another thread", () => {
  const working = (overrides, connected) =>
    renderHome({ projects: [project("app")], threads: [thread(overrides)], connected }).buttons.some((button) => button.label === "app: 1 agent working");
  for (const status of ["preparing", "starting", "running"]) assert.equal(working({ runtime: { status } }), true, status);
  for (const status of ["waiting", "idle", "completed", "failed"]) assert.equal(working({ runtime: { status } }), false, status);
  assert.equal(working({ runtime: null }), false);
  assert.equal(working({ hasPendingUserInput: true }), false);
  assert.equal(working({ hasPendingApprovals: true }), false);
  assert.equal(working({ pendingSubagentRequest: "approval" }), false);
  assert.equal(working({ archivedAt: "2026-01-01" }), false);
  assert.equal(working({ lineage: { relationshipToParent: "subagent" } }), false);
  assert.equal(working({ lineage: { relationshipToParent: null, sideChat: true } }), false);
  assert.equal(working({ lineage: { relationshipToParent: "fork" } }), true);
  assert.equal(working({}, []), false);
});

test("a project whose release or comparison is unknown is read in part, not nothing open", () => {
  for (const unknown of [facts({ failedField: true, release: undefined }), facts({ release: { tag: "v1", at: 1, ahead: null } })]) {
    const { shown } = renderHome({ projects: [project("app", "o/app")], github: { problem: null, repositories: { "o/app": unknown } } });
    assert.match(shown, /Read in part(AP)?\s*app/);
    assert.doesNotMatch(shown, /Nothing/);
  }
  const item = { number: 1, title: "Pull 1", at: 1, stage: "open", tone: "", note: "", update: false };
  const row = facts({ pulls: [item], release: { tag: "v1", at: 1, ahead: null } });
  const active = renderHome({ projects: [project("app", "o/app")], github: { problem: null, repositories: { "o/app": row } } }).shown;
  assert.match(active, /v1.*\nRead in part/s);
  assert.doesNotMatch(active, /\+/, "a field that failed does not cut the list");
  const absent = { problem: null, repositories: { "o/app": facts() } };
  assert.match(renderHome({ projects: [project("app", "o/app")], github: absent }).shown, /Nothing open/);
});

test("a project is nothing open only when GitHub was read, and otherwise says what is known", () => {
  const projects = [project("read", "o/read"), project("waiting", "o/waiting"), project("failed", "o/failed"), project("local")];
  const github = { problem: null, repositories: { "o/read": facts(), "o/waiting": { status: "waiting" }, "o/failed": { status: "unavailable" } } };
  const { shown } = renderHome({ projects, github });
  assert.match(shown, /Nothing open(RE)?\s*read/);
  assert.match(shown, /Reading GitHub(WA)?\s*waiting/);
  assert.match(shown, /GitHub is not available(FA)?\s*failed/);
  assert.match(shown, /Not on GitHub(LO)?\s*local/);
  assert.doesNotMatch(shown, /Nothing is open\./);
  assert.match(renderHome({ projects: [project("read", "o/read")], github }).shown, /Nothing is open\./);
});

test("totals leave dependency updates out, and say when a list is cut", () => {
  const item = (number, stage, tone, update = false) => ({ number, title: `Pull ${number}`, at: 1, stage, tone, note: "", update });
  const pulls = [item(1, "ready", "ok"), item(2, "ready", "ok", true), item(3, "open", "bad"), item(4, "open", "warn", true)];
  const github = { problem: null, repositories: { "o/app": facts({ pulls, release: { tag: "v1", at: 1, ahead: 5 } }) } };
  const { shown, buttons, links } = renderHome({ projects: [project("app", "o/app")], github });
  assert.match(shown, /0\nWorking\n1\nPull request\n1\nReady to merge\n5\nNot released/);
  assert.ok(buttons.some((button) => button.label === "app: 1 pull request, 1 dependency update"));
  assert.ok(links.some((link) => link.name === "Pull 1" && link.href === "https://github.com/o/app/pull/1"));
  const cut = { problem: null, repositories: { "o/app": facts({ pulls: pulls.slice(2), cut: true }) } };
  assert.match(renderHome({ projects: [project("app", "o/app")], github: cut }).shown, /1\+\nPull request\n0\+\nReady to merge\n0\nNot released/);
});

test("projects of one repository are one row, whose new thread starts in the project used last", () => {
  const projects = [project("here", "o/app"), project("there", "O/App", "remote")];
  const threads = [thread({ projectId: "here" }), thread({ id: "t2", environmentId: "remote", projectId: "there", updatedAt: "2026-11-24T11:00:00Z" })];
  const map = renderHome({ projects, threads, connected: ["local", "remote"] });
  assert.ok(map.buttons.some((button) => button.label === "there: 2 agents working"));
  const page = renderHome({ projects, threads, connected: ["local", "remote"], search: { project: "o/app" } });
  page.buttons.find((button) => /New thread/.test(button.name)).click();
  assert.deepEqual(page.calls.at(-1), ["new", { environmentId: "remote", projectId: "there" }]);
  const offline = renderHome({ projects, threads, connected: ["local"], search: { project: "o/app" } });
  offline.buttons.find((button) => /New thread/.test(button.name)).click();
  assert.deepEqual(offline.calls.at(-1), ["new", { environmentId: "local", projectId: "here" }], "a connected computer comes first");
  page.buttons.find((button) => /Home/.test(button.name)).click();
  assert.deepEqual(page.calls.at(-1), ["go", { to: "/" }]);
});

test("a chosen project that is gone shows the map", () => {
  assert.match(renderHome({ projects: [project("app")], search: { project: "o/gone" } }).shown, /Not on GitHub/);
});

test("the page's styles stay inside the page", () => {
  for (const line of HOME_CSS.split("\n").filter((item) => /^\S.*\{/.test(item) && !item.startsWith("@"))) {
    assert.match(line, /\.t3h/, line);
  }
  assert.doesNotMatch(homeView.toString(), /innerHTML|dangerouslySetInnerHTML/);
});

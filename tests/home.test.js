"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ROUTE_URL, ROUTE_URL_PATTERN, patchHomeRoute } = require("../src/home-route");
const { BACKGROUND_MS, FRESH_MS, LANES, createHomeGithub, readAlerts, readAnswer, readRequest, stageOf } = require("../src/home-github");
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
  pullRequests: { totalCount: 1, nodes: [pull(7)] },
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
  assert.equal(read.openPulls, 1);
  assert.deepEqual(read.release, { tag: "v1", at: Date.parse("2026-11-23T00:00:00Z"), ahead: 2 });
  assert.equal(read.pulls[0].number, 7);

  assert.equal(readAnswer(answer(repository({ latestRelease: null }))).release, null);
  const failed = readAnswer(answer(repository({ latestRelease: null }), [{ path: ["repository", "latestRelease"] }]));
  assert.equal(failed.release, undefined);
  assert.equal(failed.failedField, true);
  assert.equal(failed.cut, false);
  assert.equal(readAnswer(answer(repository({ latestRelease: { tagName: "v1", tag: null } }))).release.ahead, null);
  assert.equal(readAnswer(answer(repository({ pullRequests: { totalCount: 2, nodes: [pull(1)] } }))).cut, true);
  const lost = readAnswer(answer(repository({ pullRequests: { totalCount: 2, nodes: [pull(1), null] } }), [{ path: ["repository", "pullRequests", "nodes", 1] }]));
  assert.deepEqual([lost.cut, lost.failedField], [true, true], "a lost pull request is missing from the list");
  assert.equal(readAnswer(answer(repository({ pullRequests: { totalCount: 1, nodes: null } }))).cut, true);
  const none = readAnswer(answer(repository({ pullRequests: null }), [{ path: ["repository", "pullRequests"] }]));
  assert.deepEqual([none.cut, none.openPulls, none.pulls.length], [true, null, 0]);
  assert.equal(readAnswer(answer(repository({ defaultBranchRef: { target: { statusCheckRollup: { state: "FAILURE" } } } }))).mainFails, true);
  assert.equal(readAnswer(answer(null, [{ type: "NOT_FOUND" }])), null);
  assert.equal(readAnswer("<html>"), null);
});

const lines = (...list) => ({ error: null, stdout: list.map((item) => `${JSON.stringify(item)}\n`).join(""), stderr: "" });
const words = (...severities) => lines(...severities.map((severity, index) => ({ number: index + 1, severity, package: `p${index}` })));
const summary = (alerts) => alerts && { total: alerts.total, critical: alerts.critical, high: alerts.high, sources: alerts.sources };

test("a repository without releases has its newest tag as its version, and one with releases keeps its latest release", () => {
  const latestTag = { nodes: [{ name: "v2.4.2", compare: { aheadBy: 56 }, target: { committedDate: "2026-09-17T13:29:22Z" } }] };
  assert.deepEqual(readAnswer(answer(repository({ latestRelease: null, latestTag }))).release, { tag: "v2.4.2", at: Date.parse("2026-09-17T13:29:22Z"), ahead: 56, tagOnly: true });
  const annotated = { nodes: [{ name: "v1", compare: null, target: { target: { committedDate: "2026-01-01T00:00:00Z" } } }] };
  assert.deepEqual(readAnswer(answer(repository({ latestRelease: null, latestTag: annotated }))).release, { tag: "v1", at: Date.parse("2026-01-01T00:00:00Z"), ahead: null, tagOnly: true });
  assert.equal(readAnswer(answer(repository({ latestTag }))).release.tag, "v1");
  assert.equal(readAnswer(answer(repository({ latestRelease: null, latestTag: { nodes: [] } }))).release, null);
  const page = renderHome({ projects: [project("app", "o/app")], threads: [thread()], github: answered({ "o/app": facts({ release: { tag: "v2", at: Date.now(), ahead: 0, tagOnly: true } }) }) });
  assert.equal(page.links.find((item) => item.label?.startsWith("Version")).href, "https://github.com/o/app/releases/tag/v2");
});

test("alerts are counted from the sources that answer, and unknown when one failed", () => {
  const failed = (stderr) => ({ error: new Error("exit 1"), stdout: '{"message":"critical"}', stderr });
  const off = failed("gh: Dependabot alerts are disabled for this repository. (HTTP 403)");
  const absent = failed("gh: no analysis found (HTTP 404)");
  const read = readAlerts([words("critical", "high", "moderate", "high"), words("error", "note"), lines({ number: 4, type: "GitHub Token" })]);
  assert.deepEqual(summary(read), { total: 7, critical: 1, high: 3, sources: ["Dependabot", "code scanning", "secret scanning"] });
  assert.deepEqual(read.lists.dependabot.alerts.find((alert) => alert.number === 3), { number: 3, severity: "medium", package: "p2" });
  assert.deepEqual(read.lists.secretScanning, { value: 1, capped: false, alerts: [{ number: 4, type: "GitHub Token" }] });
  assert.deepEqual(summary(readAlerts([words(), absent, off])), { total: 0, critical: 0, high: 0, sources: ["Dependabot"] });
  const many = readAlerts([words(...Array.from({ length: 130 }, () => "high")), absent, off]);
  assert.deepEqual([many.total, many.high, many.lists.dependabot.value, many.lists.dependabot.alerts.length], [130, 130, 130, 100], "a long list is kept in part, and counted in full");
  const late = readAlerts([words(...Array.from({ length: 100 }, () => "low"), "critical"), absent, off]);
  assert.deepEqual([late.critical, late.lists.dependabot.alerts[0].severity], [1, "critical"], "the part kept holds the most severe");
  assert.equal(readAlerts([lines("x", [1]), absent, off]).total, 2, "an alert that cannot be read still counts");
  assert.equal(readAlerts([off, absent, off]), null);
  assert.equal(readAlerts([words("high"), failed("gh: API rate limit exceeded for user ID 1. (HTTP 403)"), off]), null);
  assert.equal(readAlerts([words("high"), off, failed("error connecting to api.github.com")]), null);
});

test("dependency updates are known by their author alone", () => {
  const logins = ["dependabot", "dependabot[bot]", "renovate", "renovate[bot]", "t3-code-bot", "github-actions"];
  const nodes = logins.map((login, index) => pull(index + 1, login));
  const read = readAnswer(answer(repository({ pullRequests: { totalCount: nodes.length, nodes } })));
  assert.deepEqual(read.pulls.map((item) => item.update), [true, true, true, true, false, false]);
});

function github({ answers = () => answer(repository()), alerts = () => "", ...options } = {}) {
  const calls = [];
  const alertCalls = [];
  let time = 1e6;
  let active = 0;
  let most = 0;
  const run = async (file, args) => {
    if (args.includes("--paginate")) {
      alertCalls.push(args);
      await new Promise((resolve) => setImmediate(resolve));
      return { stdout: alerts(args), stderr: "", error: null };
    }
    const owner = args.find((arg) => arg.startsWith("owner=")).slice(6);
    const name = args.find((arg) => arg.startsWith("name=")).slice(5);
    calls.push({ file, args, name: `${owner}/${name}` });
    most = Math.max(most, (active += 1));
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    const result = answers(`${owner}/${name}`);
    return typeof result === "string" ? { stdout: result, stderr: "", error: null } : result;
  };
  const service = createHomeGithub({ run, now: () => time, ...options });
  return { calls, alertCalls, service, most: () => most, pass: (ms) => (time += ms) };
}
const settle = async () => {
  for (let i = 0; i < 120; i += 1) await new Promise((resolve) => setImmediate(resolve));
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
  assert.equal(got.length, 21);
  assert.ok(got.slice(0, 11).every((facts) => !Object.values(facts.repositories).some((item) => item.alerts)), "pull requests come before alerts");
  assert.equal(got.at(-1).problem, null);
  assert.ok(names.every((name) => got.at(-1).repositories[name].status === "read"));
  assert.ok(calls.every((call) => call.file === "gh" && call.args.join(" ").includes("--hostname github.com")));
});

test("alerts leave gh with only the fields shown, secrets stay hidden, and alerts of a failed read do not stay", async () => {
  let broken = false;
  const { alertCalls, service, pass } = github({
    answers: () => (broken ? answer(null) : answer(repository())),
    alerts: (args) => (args.join(" ").includes("dependabot") ? words("critical", "low").stdout : ""),
  });
  const read = async () => {
    const got = [];
    service.read("a", ["o/one"], (facts) => got.push(facts));
    await settle();
    return got.at(-1).repositories["o/one"];
  };
  assert.deepEqual((await read()).alerts, { total: 2, critical: 1, high: 0, sources: ["Dependabot", "code scanning", "secret scanning"] });
  assert.equal(alertCalls.length, 3);
  assert.ok(alertCalls.every((args) => args.includes("github.com") && args.includes("-q") && args.some((arg) => arg.startsWith("repos/o/one/"))));
  const secrets = alertCalls.find((args) => args.join(" ").includes("secret-scanning"));
  assert.ok(secrets.some((arg) => arg.includes("hide_secret=true")));
  assert.equal(secrets.at(-1), ".[] | {number, type: (.secret_type_display_name // .secret_type)} | tojson");
  pass(FRESH_MS);
  await read();
  assert.equal(alertCalls.length, 6);
  broken = true;
  pass(FRESH_MS);
  const stale = await read();
  assert.deepEqual([stale.status, stale.stale, stale.alerts], ["read", true, null]);
  assert.equal(alertCalls.length, 6);
  broken = false;
  pass(FRESH_MS);
  assert.equal((await read()).alerts.total, 2, "and are read again after a failure");
});

test("a window that asks while alerts are read does not wait for them, and an older read's alerts do not come back", async () => {
  const held = [];
  let broken = false;
  let time = 1e6;
  const run = (file, args) => {
    if (!args.includes("--paginate")) return Promise.resolve({ stdout: broken ? answer(null) : answer(repository()), stderr: "", error: null });
    return new Promise((resolve) => held.push(() => resolve({ stdout: "high\n", stderr: "", error: null })));
  };
  const service = createHomeGithub({ run, now: () => time });
  const ask = (key, name) => {
    const got = [];
    service.read(key, [name], (facts) => got.push(facts.repositories[name]));
    return got;
  };
  ask("a", "o/one");
  await settle();
  const second = ask("b", "o/two");
  await settle();
  assert.equal(second.at(-1).status, "read", "its pull requests are there, while the alerts of both are still read");
  time += FRESH_MS;
  broken = true;
  const failed = ask("a", "o/one");
  await settle();
  while (held.length) {
    held.shift()();
    await settle();
  }
  assert.deepEqual([failed.at(-1).stale, failed.at(-1).alerts], [true, null]);
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
  const again = read("a", ["o/one"]);
  pass(1000);
  await settle();
  assert.equal(calls.length, 4);
  assert.equal(again.at(-1).repositories["o/one"].readAt, 1e6 + FRESH_MS, "facts are from when their read started");
});

test("while Home is closed, facts are read again once an hour, for the windows that asked, and only while Home is on", async () => {
  let on = true;
  const { calls, service, pass } = github({ isOn: () => on });
  service.read("a", ["o/one"], () => {});
  await settle();
  const refreshed = async () => {
    service.refresh();
    await settle();
    return calls.length;
  };
  pass(BACKGROUND_MS - 1);
  assert.equal(await refreshed(), 1);
  pass(1);
  assert.equal(await refreshed(), 2);
  pass(BACKGROUND_MS);
  on = false;
  assert.equal(await refreshed(), 2);
  on = true;
  service.forget("a");
  assert.equal(await refreshed(), 2);
});

const folder = (t) => {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), "t3-home-cache-"));
  t.after(() => fs.rmSync(made, { recursive: true, force: true }));
  return path.join(made, "home-cache.json");
};

test("a restart shows the saved facts at once, and reads only the old ones again", async (t) => {
  const file = folder(t);
  const first = github({ file });
  first.service.read("a", ["o/one", "o/gone"], () => {});
  await settle();
  first.service.read("a", ["o/one"], () => {});
  first.service.note("o/one", { issues: { value: 9 }, pulls: null });
  const next = github({ file });
  const got = [];
  next.service.read("a", ["o/one"], (facts) => got.push(facts.repositories["o/one"]));
  assert.deepEqual([got[0].status, got[0].issues, got[0].pulls.length], ["read", 9, 1]);
  await settle();
  assert.equal(next.calls.length, 0);
  const later = github({ file });
  later.pass(8 * 24 * 60 * 60 * 1000);
  later.service.forget("a");
  later.service.note("o/one", { issues: { value: 10 }, pulls: null });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).repositories["o/one"].facts.issues, 10, "the card updates the file before Home opens, and without a window");
  const old = [];
  github({ file, now: () => 1e6 + 8 * 24 * 60 * 60 * 1000 }).service.read("a", ["o/one"], (facts) => old.push(facts.repositories["o/one"].status));
  assert.equal(old[0], "waiting", "answers of last week are dropped");
  await settle();
  for (const damaged of ["{", '{"format":0,"repositories":{"o/one":{}}}', "null"]) {
    fs.writeFileSync(file, damaged);
    const empty = [];
    github({ file }).service.read("a", ["o/one"], (facts) => empty.push(facts.repositories["o/one"].status));
    assert.equal(empty[0], "waiting", damaged);
    await settle();
  }
});

test("the thread details card's counts update Home, keep what they do not say, and are not read again", async () => {
  const { alertCalls, calls, service, pass } = github({ alerts: (args) => (args.join(" ").includes("dependabot") ? words("critical").stdout : "") });
  const got = [];
  service.read("a", ["o/one"], (facts) => got.push(facts.repositories["o/one"]));
  await settle();
  assert.equal(alertCalls.length, 3);
  const item = (number, author = "someone", draft = false) => ({ number, title: `New ${number}`, author, time: 5, draft });
  const list = (...severities) => ({ value: severities.length, capped: false, alerts: severities.map((severity) => ({ severity })) });
  const counts = {
    issues: { value: 12 }, pulls: { value: 3, items: [item(8, "dependabot"), item(9, "someone", true), item(7)] },
    dependabot: list("high", "low"), codeScanning: list("high"), secretScanning: list(),
  };
  pass(FRESH_MS - 1);
  service.note("O/One", counts);
  let facts = got.at(-1);
  assert.deepEqual([facts.issues, facts.openPulls, facts.cut], [12, 3, false]);
  assert.deepEqual(facts.pulls.map(({ number, title, update, stage, note }) => [number, title, update, stage, note]), [
    [8, "New 8", true, "open", "merge state unknown"], [9, "New 9", false, "open", "draft"], [7, "New 7", false, "ready", ""],
  ]);
  assert.deepEqual(facts.alerts, { total: 3, critical: 0, high: 2, sources: ["Dependabot", "code scanning", "secret scanning"] });
  assert.equal(facts.release.tag, "v1");
  service.note("o/one", { ...counts, pulls: { value: 1, items: [item(7, "someone", true)] } });
  assert.equal(got.at(-1).pulls[0].note, "draft", "a ready one that went back to draft");
  pass(1);
  service.read("a", ["o/one"], (next) => got.push(next.repositories["o/one"]));
  await settle();
  assert.deepEqual([calls.length, alertCalls.length], [2, 3], "the alerts are still fresh");

  for (const less of [{ ...counts, codeScanning: null }, { ...counts, dependabot: { value: 200, capped: false, alerts: [{ severity: "low" }] } }, { ...counts, secretScanning: { ...list(), capped: true } }]) {
    service.note("o/one", less);
    assert.equal(got.at(-1).alerts.total, 3, "counts that cover less do not replace them");
  }
  service.note("o/unknown", counts);
  service.note("o/one", { issues: null, pulls: null, dependabot: null, codeScanning: null, secretScanning: null });
  assert.equal(got.at(-1).issues, 12, "what could not be read changes nothing");
});

test("each count above zero has the popover of the thread details card, from Home's own reads and from the card's", async () => {
  const issue = (number) => ({ number, title: `Issue ${number}`, updatedAt: "2026-11-24T00:00:00Z", author: { login: "someone" }, labels: { nodes: [{ name: "bug", color: "d73a4a" }] } });
  const node = repository({
    issues: { totalCount: 40, nodes: [issue(5), issue(4)] },
    pullRequests: { totalCount: 1, nodes: [{ ...pull(7), isDraft: true, reviewDecision: "APPROVED" }] },
  });
  const { service } = github({
    answers: () => answer(node),
    alerts: (args) => (args.join(" ").includes("dependabot") ? words("critical", "low").stdout : ""),
  });
  const got = [];
  service.read("a", ["o/one"], (facts) => got.push(facts.repositories["o/one"]));
  await settle();
  const { details, issueItems } = got.at(-1);
  assert.equal(issueItems, undefined, "the lists reach the page only as the popovers");
  assert.deepEqual([details.issue.title, details.issue.summary, details.issue.sections[0].more, details.issue.sections[0].link], ["Issues", "40 open", 38, "issues"]);
  assert.deepEqual(details.issue.sections[0].items[0], {
    lead: "#5", text: "Issue 5", meta: ["someone"], time: Date.parse("2026-11-24T00:00:00Z"), badges: [{ text: "bug", color: "d73a4a" }], link: "issues/5",
  });
  assert.deepEqual(details.pull.sections[0].items[0].badges.map((badge) => badge.text), ["Draft", "Approved"]);
  assert.deepEqual(details.shield.sections.map((section) => section.title), ["Dependabot · 2"], "a source without alerts has no section");
  assert.deepEqual(details.shield.sections[0].items.map((item) => [item.text, item.link]), [["p0", "security/dependabot/1"], ["p1", "security/dependabot/2"]]);

  service.note("o/one", {
    issues: { value: 1, capped: false, items: [{ number: 9, title: "From the card", author: "a", time: 1, labels: [] }] },
    pulls: { value: 1, items: [{ number: 7, title: "Seven", author: "b", time: 2, draft: false, review: "CHANGES_REQUESTED" }] },
  });
  const noted = got.at(-1).details;
  assert.deepEqual(noted.issue.sections[0].items.map((item) => item.text), ["From the card"]);
  assert.deepEqual(noted.pull.sections[0].items[0].badges.map((badge) => badge.text), ["Changes requested"]);
  service.note("o/one", { issues: { value: 0, items: [] }, pulls: null });
  assert.equal(got.at(-1).details.issue, undefined, "no popover for nothing");
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
    homeGithub: { read: (key, names, deliver) => (asked.push([key, names]), deliver({ problem: null, repositories: {} })), forget: (key) => asked.push(["forget", key]) },
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
  on.service.forget("s");
  assert.deepEqual(on.asked.at(-1), ["forget", "s"]);

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
// value, effects do not run, and refs given by the test stay between renders.
function renderHome({ projects = [], threads = [], bootstrapped = true, connected = ["local"], search = {}, github = null, fail = false, opened = [], refs = [] } = {}) {
  const calls = [];
  let nextRef = 0;
  let receive = null;
  globalThis.document = { addEventListener: (type, listener) => (receive = listener) };
  const React = {
    Component: class { constructor(props) { this.props = props; } },
    Fragment: ({ children }) => children,
    createElement: (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? { children: children.length > 1 ? children : children[0] } : {}) } }),
    useState: (first) => {
      const value = typeof first === "function" ? first() : first;
      return [value instanceof Set ? new Set(opened) : value, () => {}];
    },
    useEffect() {},
    useLayoutEffect() {},
    useRef: (current) => (refs[nextRef++] ??= { current }),
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
  if (github) receive({ detail: JSON.stringify(github) });
  const buttons = [];
  const links = [];
  const classes = [];
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
    if (props.className) classes.push([props.className, inner]);
    if (type === "button") buttons.push({ name: inner || props["aria-label"], label: props["aria-label"], click: props.onClick });
    if (type === "a") links.push({ name: inner, label: props["aria-label"], href: props.href, props });
    return inner + (type === "i" ? "" : "\n");
  };
  const shown = text(React.createElement(Home, { native: () => "T3 Code's own page" })).replace(/\n+/g, "\n");
  const having = (name) => classes.filter(([className]) => className.split(" ").includes(name)).map(([, inner]) => inner.replace(/\n+/g, "\n").trim());
  return { shown, buttons, links, calls, having, cards: having("t3h-card"), tiles: having("t3h-tile") };
}

const HOUR = 60 * 60 * 1000;
const before = (hours) => new Date(Date.now() - hours * HOUR).toISOString();
const project = (id, repository, overrides = {}) => ({
  id, environmentId: "local", title: id, archivedAt: null, pinnedAt: null,
  ...(repository ? { repositoryIdentity: { canonicalKey: `github.com/${repository}` } } : {}), ...overrides,
});
const thread = (overrides = {}) => ({
  id: "t1", environmentId: "local", projectId: "app", title: "A thread", createdAt: before(2), archivedAt: null, settledOverride: null,
  runtime: null, latestRun: null, lineage: { relationshipToParent: null }, hasPendingApprovals: false, hasPendingUserInput: false, pullRequests: [], ...overrides,
});
const running = { runtime: { status: "running", activityStartedAt: before(1) } };
const facts = (overrides = {}) => ({
  status: "read", readAt: 1, stale: false, pulls: [], issues: 0, openPulls: 0, alerts: null, release: null, mainFails: false, failedField: false, cut: false, ...overrides,
});
const pullFact = (number, overrides = {}) => ({ number, title: `Pull ${number}`, at: Date.now(), stage: "ready", tone: "ok", note: "", update: false, ...overrides });
const answered = (repositories) => ({ problem: null, repositories });

test("T3 Code's own page shows only with no projects after they all loaded, and when Home fails", () => {
  assert.equal(renderHome({ bootstrapped: false }).shown, "");
  assert.equal(renderHome({ bootstrapped: true }).shown, "T3 Code's own page");
  assert.equal(renderHome({ projects: [project("old", null, { archivedAt: "2026-01-01" })] }).shown, "T3 Code's own page");
  assert.match(renderHome({ projects: [project("app")], bootstrapped: false }).shown, /No open work\n1 project\nAP\napp/);
  const silenced = console.error;
  console.error = () => {};
  try {
    assert.equal(renderHome({ projects: [project("app")], fail: true }).shown, "T3 Code's own page");
  } finally {
    console.error = silenced;
  }
});

test("a thread is open work until it is settled, archived, or snoozed, and never as a part of another thread", () => {
  const open = (overrides) => renderHome({ projects: [project("app")], threads: [thread(overrides)] }).cards.length === 1;
  assert.equal(open({}), true);
  assert.equal(open({ settledOverride: "active" }), true);
  assert.equal(open({ lineage: { relationshipToParent: "fork" } }), true);
  assert.equal(open({ settledOverride: "settled" }), false);
  assert.equal(open({ archivedAt: before(1) }), false);
  assert.equal(open({ lineage: { relationshipToParent: "subagent" } }), false);
  assert.equal(open({ lineage: { relationshipToParent: null, sideChat: true } }), false);
});

test("a snoozed thread comes back at its time, or when something new needs its owner", () => {
  const open = (overrides) =>
    renderHome({ projects: [project("app")], threads: [thread({ snoozedUntil: before(-5), snoozedAt: before(5), ...overrides })] }).cards.length === 1;
  assert.equal(open({}), false);
  assert.equal(open({ snoozedUntil: before(1) }), true);
  assert.equal(open(running), false);
  assert.equal(open({ hasPendingUserInput: true, pendingUserInputAt: before(6) }), false);
  assert.equal(open({ hasPendingUserInput: true, pendingUserInputAt: before(1) }), true);
  assert.equal(open({ hasPendingUserInput: true, pendingUserInputAt: before(6), snoozedAt: null }), true);
  assert.equal(open({ hasPendingApprovals: true }), true);
  assert.equal(open({ pendingSubagentRequest: "approval" }), true);
  assert.equal(open({ pendingGuestMessageCount: 1 }), true);
  assert.equal(open({ source: { pendingRuntimeRequest: { kind: "auth_refresh" } } }), true);
  assert.equal(open({ runtime: { status: "failed", updatedAt: before(9) }, latestRun: { status: "failed", completedAt: before(9) } }), false);
  assert.equal(open({ runtime: { status: "failed", updatedAt: before(1) }, latestRun: { status: "failed", completedAt: before(1) } }), true);
});

test("a card says what its agent does, and a computer that is not connected has no working agent", () => {
  const card = (overrides, connected) => renderHome({ projects: [project("app")], threads: [thread(overrides)], connected }).cards[0];
  for (const status of ["preparing", "queued", "starting", "running", "waiting"]) {
    assert.match(card({ runtime: { status, activityStartedAt: before(1) } }), /Working, 60m|Working, 1h/, status);
  }
  for (const status of ["completed", "failed", "interrupted", "idle"]) assert.doesNotMatch(card({ runtime: { status } }), /Working/, status);
  assert.match(card({ runtime: { status: "idle" }, pendingBackgroundTasks: [{}] }), /Working/);
  assert.doesNotMatch(card(running, []), /Working/);
  for (const waits of [{ hasPendingUserInput: true }, { hasPendingApprovals: true }, { pendingSubagentRequest: "approval" }, { pendingGuestMessageCount: 1 }]) {
    assert.match(card({ ...running, ...waits }), /Waiting for you/);
    assert.doesNotMatch(card({ ...running, ...waits }), /Working/);
  }
  assert.match(card({ latestRun: { status: "failed", completedAt: before(1) } }), /Error/);
  const done = { latestRun: { status: "completed", completedAt: before(1) } };
  assert.match(card({ ...done, lastVisitedAt: before(2) }), /Finished/);
  assert.doesNotMatch(card({ ...done, lastVisitedAt: before(0.5) }), /Finished/);
  assert.doesNotMatch(card(done), /Finished/);
  assert.doesNotMatch(card({ latestRun: { status: "interrupted", completedAt: before(1) }, lastVisitedAt: before(2) }), /Finished/);
});

test("pinned projects come first, then working ones, then the latest, and a pinned one always has a card", () => {
  const projects = [project("quiet"), project("new"), project("works"), project("pinned", null, { pinnedAt: before(1) }), project("old")];
  const threads = [
    thread({ id: "1", projectId: "old", createdAt: before(90) }),
    thread({ id: "2", projectId: "new", createdAt: before(1) }),
    thread({ id: "3", projectId: "works", createdAt: before(50), ...running }),
  ];
  const { cards, tiles } = renderHome({ projects, threads });
  assert.deepEqual(cards.map((card) => /(quiet|new|works|pinned|old)/.exec(card)[1]), ["pinned", "works", "new", "old"]);
  assert.equal(tiles.length, 1);
});

test("cards and their rows stay where they are while Home is open", () => {
  const refs = [];
  const projects = [project("a"), project("b"), project("c")];
  const of = (projectId, id, hours, overrides = {}) => thread({ id, title: id, projectId, createdAt: before(hours), ...overrides });
  const show = (threads, options = {}) => {
    const page = renderHome({ projects, threads, refs, ...options });
    return [page.cards.map((card) => card.split("\n")[1]), page.having("t3h-row").map((row) => row.split("\n")[0])];
  };
  assert.deepEqual(show([of("a", "a1", 1), of("a", "a2", 2), of("b", "b1", 3)]), [["a", "b"], ["a1", "a2", "b1"]]);
  assert.deepEqual(show([of("a", "a1", 1), of("a", "a2", 2, running), of("b", "b1", 3, running)]), [["a", "b"], ["a1", "a2", "b1"]], "agents start");
  const long = 24 * 20;
  const old = [1, 2, 3, 4].map((number) => of("a", `x${number}`, number)).concat(of("a", "y1", long), of("a", "y2", long + 1));
  const oldRefs = [];
  const order = show(old, { refs: oldRefs })[1];
  assert.deepEqual(order, ["x1", "x2", "x3", "x4", "y1"]);
  assert.deepEqual(show([...old.slice(0, 5), of("a", "y2", long + 1, { hasPendingApprovals: true })], { refs: oldRefs })[1], order, "an old thread wakes");
  assert.deepEqual(show([of("a", "a1", 1), of("a", "a2", 2), of("a", "a3", 0.1), of("b", "b1", 3), of("c", "c1", 0)]), [["a", "b", "c"], ["a3", "a1", "a2", "b1", "c1"]], "a new card is last, and a new thread first");
  assert.deepEqual(show([of("b", "b1", 3), of("c", "c1", 0)]), [["b", "c"], ["b1", "c1"]]);
  assert.deepEqual(show([of("b", "b1", 3), of("c", "c1", 0)], { refs: [] }), [["c", "b"], ["c1", "b1"]], "the next visit orders them again");
  const partly = [];
  show([of("b", "b1", 1), of("c", "c1", 2)], { bootstrapped: false, refs: partly });
  assert.deepEqual(show([of("b", "b1", 1), of("c", "c1", 2, running)], { refs: partly })[0], ["c", "b"], "the order is kept from when T3 Code loaded everything");
});

test("a pull request is on the row of the thread it is linked to, and otherwise has its own row", () => {
  const link = (number, overrides = {}) => ({ host: "github.com", repository: "O/App", number, linkedAt: before(9), snapshot: { state: "open" }, ...overrides });
  const pulls = [pullFact(1), pullFact(2, { stage: "open", tone: "warn", note: "conflicts" }), pullFact(3, { update: true })];
  const threads = [thread({ pullRequests: [link(1), link(7), link(8, { linkedAt: before(1) }), link(9, { snapshot: { state: "merged" } }), link(2, { repository: "o/other" })] })];
  const projects = [project("app", "o/app")];
  const page = renderHome({ projects, threads, github: answered({ "o/app": facts({ pulls, openPulls: 3, readAt: Date.parse(before(5)) }) }) });
  const rows = page.having("t3h-row");
  assert.match(rows[0], /^A thread\n2h\n#1 ready to merge\n#8 open$/);
  assert.match(rows[1], /^Pull 2\n1m\n#2 conflicts$/);
  assert.equal(rows.length, 2, "dependency updates have no row");
  assert.ok(page.links.some((item) => item.name.trim() === "#1 ready to merge" && item.href === "https://github.com/o/app/pull/1"));
  const left = [thread({ createdAt: before(24 * 20), pullRequests: [link(1)] })];
  const apart = renderHome({ projects, threads: left, github: answered({ "o/app": facts({ pulls: [pullFact(1)], openPulls: 1 }) }) }).having("t3h-row");
  assert.match(apart[0], /^Pull 1/, "a thread left long ago does not hide its pull request");
  assert.match(renderHome({ projects, threads }).having("t3h-row")[0], /#1 open\n#7 open\n#8 open$/, "T3 Code's links alone, until GitHub is read");
});

test("rows past the fifth are behind a button, and threads left long ago come last", () => {
  const threads = Array.from({ length: 8 }, (_, index) => thread({ id: `t${index}`, title: `Thread ${index}`, createdAt: before(index === 0 ? 24 * 20 : index) }));
  const closed = renderHome({ projects: [project("app")], threads });
  assert.deepEqual(closed.having("t3h-row").map((row) => row.split("\n")[0]), [1, 2, 3, 4, 5].map((number) => `Thread ${number}`));
  assert.ok(closed.buttons.some((button) => button.label === "3 more in app"));
  const open = renderHome({ projects: [project("app")], threads, opened: ["local:app"] });
  assert.equal(open.having("t3h-row").length, 8);
  assert.deepEqual(open.having("t3h-old").map((row) => row.split("\n")[0]), ["Thread 0"]);
});

test("a card counts issues, pull requests, and alerts, and leaves out what GitHub did not give", () => {
  const counts = (overrides) => renderHome({
    projects: [project("app", "o/app")], threads: [thread()], github: answered({ "o/app": facts(overrides) }),
  }).links.filter((item) => item.label).map((item) => [item.label, item.name.trim(), item.href.slice(24)]);
  const alerts = (total, critical, high) => ({ total, critical, high, sources: ["Dependabot"] });
  assert.deepEqual(counts({ issues: 2, openPulls: 3, pulls: [pullFact(1), pullFact(2, { update: true })], alerts: alerts(45, 4, 11) }), [
    ["2 issues", "2", "/issues"],
    ["3 pull requests: 3, 1 update", "3, 1 update", "/pulls"],
    ["45 security alerts in Dependabot: 45, 4 critical", "45, 4 critical", "/security"],
  ]);
  assert.deepEqual(counts({ openPulls: 2, pulls: [pullFact(1, { update: true }), pullFact(2, { update: true })], alerts: alerts(1, 0, 1) }).map((item) => item[1]), ["0", "2 updates", "1 high"]);
  assert.deepEqual(counts({ alerts: alerts(0, 0, 0) }).map((item) => item[0]), ["0 issues", "0 pull requests", "0 security alerts in Dependabot"]);
  assert.deepEqual(counts({ issues: null, openPulls: null }), []);
  assert.deepEqual(counts({ openPulls: 40, cut: true, pulls: [pullFact(1, { update: true })] })[1][1], "40", "a part of the list does not count the updates");
});

test("a count with a list opens it on hover, and the others keep their plain tooltip", () => {
  const detail = { title: "Issues", summary: "2 open", sections: [] };
  const page = renderHome({
    projects: [project("app", "o/app")], threads: [thread()],
    github: answered({ "o/app": facts({ issues: 2, openPulls: 0, details: { issue: detail } }) }),
  });
  const [issues, pulls] = page.links.filter((item) => item.label);
  assert.deepEqual([issues.props["aria-haspopup"], issues.props.title, typeof issues.props.onPointerEnter], ["dialog", undefined, "function"]);
  assert.deepEqual([pulls.props["aria-haspopup"], pulls.props.title], [undefined, "0 pull requests"]);
  assert.equal(page.having("t3h-tip")[0], "", "the popover is closed until a count is hovered");
});

test("a project has no open work only when its pull requests were read, and otherwise says why not", () => {
  const projects = ["read", "cut", "waiting", "failed"].map((id) => project(id, `o/${id}`)).concat(project("local"));
  const github = answered({ "o/read": facts(), "o/cut": facts({ cut: true }), "o/waiting": { status: "waiting" }, "o/failed": { status: "unavailable" } });
  const { shown } = renderHome({ projects, github });
  const [known, unknown] = shown.split("GitHub is not read");
  assert.match(known, /No open work\n2 projects/);
  assert.match(known, /read[\s\S]*local/);
  assert.match(unknown, /cut[\s\S]*waiting\nReading GitHub…[\s\S]*failed\nGitHub is not available/);
  const update = answered({ "o/read": facts({ pulls: [pullFact(1, { update: true })], openPulls: 1 }) });
  assert.equal(renderHome({ projects: [project("read", "o/read")], github: update }).tiles.length, 1, "updates alone are not open work");
});

test("the version is a tag at the end of the line of counts, with the commits since it", () => {
  const page = (overrides, options = {}) => renderHome({ projects: [project("app", "o/app")], threads: [thread()], github: answered({ "o/app": facts(overrides) }), ...options });
  const card = (overrides) => page(overrides).cards[0];
  const at = Date.now() - 3 * HOUR;
  assert.deepEqual(page({ release: { tag: "v1", at, ahead: 0 } }).having("t3h-counts"), ["0\n0\nv1"]);
  const ahead = page({ release: { tag: "v1.2", at, ahead: 3 } });
  assert.match(ahead.cards[0], /\nv1.2\n\+3$/);
  assert.deepEqual(page({ issues: null, openPulls: null, release: { tag: "v1", at, ahead: 0 } }).having("t3h-counts"), ["v1"], "the tag alone still has its line");
  assert.deepEqual(ahead.links.filter((item) => item.label?.startsWith("Version")).map(({ label, href }) => [label, href]), [
    ["Version v1.2, 3 commits since", "https://github.com/o/app/compare/v1.2...HEAD"],
  ]);
  assert.equal(page({ release: { tag: "v1", at, ahead: 0 } }).links.find((item) => item.label?.startsWith("Version")).label, "Version v1, released 3h ago");
  assert.match(page({ release: { tag: "v1", at, ahead: 0 } }, { search: { project: "o/app" } }).having("t3h-counts")[0], /\nv1$/, "and on the project's page");
  const tile = renderHome({ projects: [project("app", "o/app")], github: answered({ "o/app": facts({ release: { tag: "v1", at, ahead: 2 } }) }) });
  assert.match(tile.tiles[0], /^AP\napp\nv1\n\+2$/);
  assert.equal(tile.links.length, 0, "a tile is one button, so its tag is no link");
  assert.match(card({ release: { tag: "v1", at, ahead: null } }), /Read in part/);
  assert.doesNotMatch(card({ release: null }), /v1/);
  assert.match(card({ failedField: true }), /Read in part/);
  assert.match(card({ mainFails: true }), /The default branch fails its checks/);
});

test("projects of one repository are one card, whose new thread starts in the project used last", () => {
  const projects = [project("here", "o/app"), project("there", "O/App", { environmentId: "remote" })];
  const threads = [thread({ projectId: "here", createdAt: before(5) }), thread({ id: "t2", environmentId: "remote", projectId: "there", createdAt: before(1) })];
  const start = (connected) => {
    const page = renderHome({ projects, threads, connected });
    assert.equal(page.cards.length, 1);
    assert.equal(page.having("t3h-row").length, 2);
    page.buttons.find((button) => /^New thread in/.test(button.label)).click();
    return page.calls.at(-1);
  };
  assert.deepEqual(start(["local", "remote"]), ["new", { environmentId: "remote", projectId: "there" }]);
  assert.deepEqual(start(["local"]), ["new", { environmentId: "local", projectId: "here" }], "a connected computer comes first");
});

test("a project's page shows every row with the dependency updates, and Home leaves it", () => {
  const threads = Array.from({ length: 8 }, (_, index) => thread({ id: `t${index}`, title: `Thread ${index}` }));
  const github = answered({ "o/app": facts({ pulls: [pullFact(3, { update: true })], openPulls: 1 }) });
  const page = renderHome({ projects: [project("app", "o/app")], threads, github, search: { project: "o/app" } });
  assert.equal(page.having("t3h-row").length, 9);
  assert.match(page.shown, /Dependency updates\nPull 3/);
  page.buttons.find((button) => /Home/.test(button.name)).click();
  assert.deepEqual(page.calls.at(-1), ["go", { to: "/" }]);
  assert.match(renderHome({ projects: [project("app")], search: { project: "o/gone" } }).shown, /No open work/);
});

test("the first answers wait for each other, unless some came from the cache", () => {
  const projects = [project("a", "o/a"), project("b", "o/b")];
  const show = (repositories) => renderHome({ projects, github: answered(repositories) }).shown;
  assert.match(show({ "o/a": facts(), "o/b": { status: "waiting" } }), /No open work\n1 project/);
  assert.match(show({ "o/a": { status: "unavailable" }, "o/b": { status: "waiting" } }), /Reading GitHub…[\s\S]*Reading GitHub…/);
});

test("a project's page says that nothing is in the middle only when its pull requests were read", () => {
  const page = (repositories) => renderHome({ projects: [project("app", "o/app")], github: answered(repositories), search: { project: "o/app" } }).shown;
  assert.match(page({ "o/app": facts() }), /Nothing is in the middle/);
  for (const [unread, reason] of [[{ status: "waiting" }, /Reading GitHub…/], [{ status: "unavailable" }, /GitHub is not available/], [facts({ cut: true }), /Read in part/]]) {
    assert.doesNotMatch(page({ "o/app": unread }), /Nothing is in the middle/);
    assert.match(page({ "o/app": unread }), reason);
  }
});

test("the page's styles stay inside the page", () => {
  for (const line of HOME_CSS.split("\n").filter((item) => /^\S.*\{/.test(item) && !item.startsWith("@"))) {
    assert.match(line, /\.t3h/, line);
  }
  assert.doesNotMatch(homeView.toString(), /innerHTML|dangerouslySetInnerHTML/);
});

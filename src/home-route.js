"use strict";

// Puts the Home page on T3 Code's start route, in place of the component that
// forwards to a new thread. That component stays in the code: Home shows it
// when there are no projects, and when Home itself fails.
//
// Home is added to T3 Code's own script for the route and gets T3 Code's own
// hooks, so its projects and threads are live. Every site must match exactly
// once. Otherwise the code is passed on byte for byte, so a T3 Code update
// turns Home off instead of breaking the start page. Names are read from the
// code around stable strings, because the minified names change with every
// build.

const { homeView, HOME_CSS } = require("./home-view");

const ID = "[\\w$]+";
const ROUTE_URL_PATTERN = "t3code://app/assets/_chat.index-*.js";
const ROUTE_URL = /^t3code:\/\/app\/assets\/_chat\.index-[^/]*\.js$/;

const escapeId = (name) => name.replace(/\$/g, "\\$");

function single(source, regex, label) {
  const found = [...source.matchAll(new RegExp(regex.source, "g"))];
  if (found.length !== 1) throw new Error(`${label}: ${found.length} matches`);
  return found[0];
}

function isModuleName(source, name) {
  const id = escapeId(name);
  return new RegExp(`\\bimport\\{(?:[^}]*[\\s,])?${id}[,}]|\\bfunction ${id}\\(|[;,]var (?:[^;]*,)?${id}=|;var ${id}=`).test(source);
}

// The source of the function that holds a place. Minified components are
// declared one after another at the top of the module.
function functionAt(source, index) {
  const start = source.lastIndexOf("function ", index);
  const next = source.slice(index).search(/}(?:function |export{)/);
  if (start < 0 || next < 0) throw new Error("no function around a place");
  return source.slice(start, index + next + 1);
}

function names(source) {
  // The component that forwards to a new thread.
  const path = single(source, new RegExp(`(${ID})\\.state\\.location\\.pathname===\`/\``), "start path");
  const forward = functionAt(source, path.index);
  const component = /^function ([\w$]+)\(\)\{/.exec(forward)?.[1];
  if (!component) throw new Error("forward: not a component");
  // The hook that a variable of the component comes from.
  const hook = (variable, label) => single(forward, new RegExp(`[,; ]${escapeId(variable)}=(${ID})\\(\\)`), label)[1];
  const sorted = single(forward, new RegExp(`=${ID}\\((${ID})\\.filter\\(${ID}\\),(${ID}),\`updated_at\`\\)\\[0\\]`), "projects");
  const opened = single(forward, new RegExp(`(${ID})\\((${ID}),\\{replace:!0\\}\\)\\.then\\(`), "new thread");
  const reference = single(forward, new RegExp(`let ${escapeId(opened[2])}=(${ID})\\((${ID})\\.environmentId,\\2\\.id\\)`), "project reference");
  const empty = single(forward, new RegExp(`=(${ID})\\?\\(0,(${ID})\\.jsx\\)\\(${ID},\\{\\}\\):null`), "no projects");
  const react = single(forward, new RegExp(`\\(0,(${ID})\\.useEffectEvent\\)`), "react")[1];

  // The frame and the header of the page that this route shows on a failure.
  const framed = single(
    source,
    new RegExp(`\\(0,${escapeId(empty[2])}\\.jsxs\\)\\((${ID}),\\{\\.\\.\\.${ID},role:\`main\`,className:\`([^\`]*)\``),
    "page frame",
  );
  const failure = functionAt(source, framed.index);
  const header = single(failure, new RegExp(`=(${ID})\\?\\(0,${escapeId(empty[2])}\\.jsx\\)\\((${ID}),\\{electron:!0\\}\\):null`), "page header");

  const route = single(source, new RegExp(`\\(0,${escapeId(empty[2])}\\.jsx\\)\\(${escapeId(component)},\\{\\}\\)`), "route");
  const routeComponent = functionAt(source, route.index);
  return {
    route,
    component,
    jsx: empty[2],
    mainScript: single(source, /from"\.\/(main-[\w$-]+\.js)"/, "main script")[1],
    frameClass: framed[2],
    module: {
      React: react,
      useProjects: hook(sorted[1], "projects hook"),
      useThreads: hook(sorted[2], "threads hook"),
      useBootstrapped: hook(empty[1], "bootstrap hook"),
      useNewThread: hook(opened[1], "new thread hook"),
      useRouter: hook(path[1], "router hook"),
      useEnvironments: single(routeComponent, new RegExp(`\\{environments:${ID},isReady:${ID}\\}=(${ID})\\(\\)`), "environments hook")[1],
      projectReference: reference[1],
      Frame: framed[1],
      focusProps: single(failure, new RegExp(`=(${ID})\\(\`home\`,1,`), "page focus")[1],
      Header: header[2],
      electron: header[1],
    },
  };
}

function patchHomeRoute(source) {
  try {
    const found = names(source);
    const foreign = Object.keys(found.module).find((key) => !isModuleName(source, found.module[key]));
    if (foreign) throw new Error(`${foreign} is not a name of the module`);
    const exported = single(source, /export\{[^}]*\};?\s*(?:\/\/[^\n]*\s*)?$/, "export");
    const given = Object.entries(found.module).map(([key, name]) => `${key}:${name}`).join(",");
    const added =
      `import*as t3RtlHomeMain$ from"./${found.mainScript}";` +
      `const t3RtlHome$=(${homeView.toString()})({${given},main:t3RtlHomeMain$,` +
      `frameClass:${JSON.stringify(found.frameClass)},css:${JSON.stringify(HOME_CSS)}});`;
    const { route } = found;
    return {
      applied: true,
      source:
        source.slice(0, route.index) +
        `(0,${found.jsx}.jsx)(t3RtlHome$,{native:${found.component}})` +
        source.slice(route.index + route[0].length, exported.index) +
        added +
        source.slice(exported.index),
    };
  } catch (error) {
    return { applied: false, source, problem: error.message };
  }
}

module.exports = { ROUTE_URL, ROUTE_URL_PATTERN, patchHomeRoute };

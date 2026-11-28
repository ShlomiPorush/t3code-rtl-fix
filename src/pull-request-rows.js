"use strict";

const ID = "[\\w$]+";
const ROW_GLOBAL = "__t3RtlPullRequestRow";

function pullRequestRow({ react, Row, rowClass, numberClass, Actor, cn }) {
  return (props, key) => {
    if (typeof props.onOpenPullRequest !== "function") return undefined;
    const { fallbackIcon, tracker } = props.t3code();
    const Icon = props.presentation?.Icon ?? fallbackIcon;
    if (!Icon) return undefined;
    const link = props.link;
    const snapshot = link.snapshot;
    const meta = react.jsxs(react.Fragment, {
      children: [
        snapshot?.author ? react.jsx(Actor, { actor: snapshot.author, tooltip: false }) : null,
        react.jsx(tracker.Icon, { role: "img", "aria-label": tracker.providerName, className: "size-3 shrink-0" }),
        react.jsx("span", { className: "truncate", children: link.repository }),
      ],
    });
    const row = react.jsx(Row, {
      number: react.jsx("span", { className: numberClass, children: `#${props.number}` }),
      title: props.title,
      status: props.children,
      meta,
      updatedAt: snapshot?.updatedAt ?? link.linkedAt,
    });
    const icon = react.jsx(Icon, {
      "aria-hidden": true,
      className: cn("size-4 shrink-0", props.presentation?.toneClassName ?? "stroke-muted-foreground"),
    });
    const line = react.jsxs("a", {
      href: props.url,
      target: "_blank",
      rel: "noopener noreferrer",
      onPointerDown: (event) => event.stopPropagation(),
      onClick: (event) => props.onOpenPullRequest(event, props.url),
      className: cn(rowClass, "px-2 hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"),
      children: [icon, row],
    });
    return react.jsx("li", { style: { paddingInlineStart: `${Math.min(props.depth ?? 0, 3) * 0.75}rem` }, children: line }, key);
  };
}

function single(source, regex, label) {
  const found = [...source.matchAll(new RegExp(regex.source, "g"))];
  if (found.length !== 1) throw new Error(`${label}: ${found.length} matches`);
  return found[0];
}

function patchMainRows(source) {
  try {
    const row = single(source, new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${ID}),\\{number:${ID},title:${ID},status:${ID},meta:${ID},updatedAt:${ID}\\}\\)`), "issue row");
    const actor = single(source, new RegExp(`\\(0,${ID}\\.jsx\\)\\((${ID}),\\{actor:${ID}\\.author,tooltip:!1\\}\\)`), "issue author");
    const number = single(source, new RegExp(`\\(0,${ID}\\.jsx\\)\\(\`span\`,\\{className:(${ID}),children:${ID}\\.displayKey\\}\\)`), "issue number");
    const line = single(source, new RegExp(`className:(${ID})\\((${ID}),\`px-2 hover:bg-accent\\/60 `), "issue line");
    const exported = single(source, /export\{[^}]*\};?\s*(?:\/\/[^\n]*\s*)?$/, "export");
    const imported = { Row: row[2], rowClass: line[2], numberClass: number[1], Actor: actor[1], cn: line[1] };
    const local = Object.keys(imported).find((part) => !new RegExp(`\\bimport\\{[^}]* as ${imported[part].replace(/\$/g, "\\$")}[,}]`).test(source));
    if (local) throw new Error(`${local} is not imported by the module`);
    const parts = `{react:${row[1]},Row:${row[2]},rowClass:${line[2]},numberClass:${number[1]},Actor:${actor[1]},cn:${line[1]}}`;
    const added = `globalThis.${ROW_GLOBAL}=(props,key)=>{try{return(${pullRequestRow.toString()})(${parts})(props,key)}catch{return undefined}};`;
    return { applied: true, source: source.slice(0, exported.index) + added + source.slice(exported.index) };
  } catch (error) {
    return { applied: false, source, problem: error.message };
  }
}

function patchCardRows(source) {
  try {
    const site = single(source, new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${ID}),\\{number:(${ID})\\.link\\.number,url:\\3\\.link\\.url,title:`), "pull request row");
    const icons = single(source, new RegExp(`=${ID}\\?\\.Icon\\?\\?(${ID})\\.pullRequest,`), "pull request icon")[1];
    const registry = single(
      source,
      new RegExp(`function ${ID}\\((${ID})\\)\\{return\\(\\(\\1===void 0\\?null:(${ID})\\.findByChangeRequestUrl\\(\\1\\)\\)\\?\\?\\2\\.get\\(void 0\\)\\)\\.changeRequest\\}`),
      "provider registry",
    )[2];
    const provider = single(source, new RegExp(`function (${ID})\\((${ID})\\)\\{return ${ID}\\.find\\(\\2\\)===void 0\\?${ID}\\[\\2\\]\\?\\?\\{providerName:\\2,Icon:`), "provider")[1];
    const [text, react, row, entry] = site;
    const url = `${entry}.link.url`;
    const replaced =
      `((props,key)=>globalThis.${ROW_GLOBAL}?.(props,key)??(0,${react}.jsx)(${row},props,key))` +
      `({link:${entry}.link,t3code:()=>({fallbackIcon:${icons}.pullRequest,` +
      `tracker:${provider}((${registry}.findByChangeRequestUrl(${url})??${registry}.get(void 0)).kind)}),` +
      `number:${entry}.link.number,url:${url},title:`;
    return { applied: true, source: source.slice(0, site.index) + replaced + source.slice(site.index + text.length) };
  } catch (error) {
    return { applied: false, source, problem: error.message };
  }
}

module.exports = { ROW_GLOBAL, patchCardRows, patchMainRows, pullRequestRow };

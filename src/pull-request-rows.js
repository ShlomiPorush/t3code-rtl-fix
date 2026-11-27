"use strict";

const ID = "[\\w$]+";
const ROW_GLOBAL = "__t3RtlPullRequestRow";

function pullRequestRow({ react, Row, rowClass, numberClass, Actor, provider, cn }) {
  const kindOf = (host) => {
    const name = String(host || "").toLowerCase();
    if (name === "github.com" || name.endsWith(".ghe.com") || name.split(".").includes("github")) return "github";
    return name.split(".")[0];
  };
  return (props, key) => {
    const link = props.link;
    const snapshot = link?.snapshot;
    if (!snapshot || !props.presentation) return undefined;
    const tracker = provider(kindOf(link.host));
    const icon = react.jsx(props.presentation.Icon, {
      "aria-hidden": true,
      className: cn("size-4 shrink-0", props.presentation.toneClassName ?? "stroke-muted-foreground"),
    });
    const meta = react.jsxs(react.Fragment, {
      children: [
        snapshot.author ? react.jsx(Actor, { actor: snapshot.author, tooltip: false }) : null,
        react.jsx(tracker.Icon, { role: "img", "aria-label": tracker.providerName, className: "size-3 shrink-0" }),
        react.jsx("span", { className: "truncate", children: link.repository }),
      ],
    });
    const row = react.jsx(Row, {
      number: react.jsx("span", { className: numberClass, children: `#${props.number}` }),
      title: props.title,
      status: props.children,
      meta,
      updatedAt: snapshot.updatedAt ?? link.linkedAt,
    });
    const opens = typeof props.onOpenPullRequest === "function";
    const line = react.jsxs(opens ? "a" : "div", {
      ...(opens
        ? {
            href: props.url,
            target: "_blank",
            rel: "noopener noreferrer",
            onPointerDown: (event) => event.stopPropagation(),
            onClick: (event) => props.onOpenPullRequest(event, props.url),
          }
        : {}),
      className: cn(
        rowClass,
        "px-2",
        opens && "hover:bg-accent/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
      ),
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
    const provider = single(source, new RegExp(`=(${ID})\\(${ID}\\.tracker\\)`), "issue provider");
    const exported = single(source, /export\{[^}]*\};?\s*(?:\/\/[^\n]*\s*)?$/, "export");
    const parts =
      `{react:${row[1]},Row:${row[2]},rowClass:${line[2]},numberClass:${number[1]},` +
      `Actor:${actor[1]},provider:${provider[1]},cn:${line[1]}}`;
    const added = `globalThis.${ROW_GLOBAL}=(${pullRequestRow.toString()})(${parts});`;
    return { applied: true, source: source.slice(0, exported.index) + added + source.slice(exported.index) };
  } catch (error) {
    return { applied: false, source, problem: error.message };
  }
}

function patchCardRows(source) {
  try {
    const site = single(source, new RegExp(`\\(0,(${ID})\\.jsx\\)\\((${ID}),\\{number:(${ID})\\.link\\.number,url:\\3\\.link\\.url,title:`), "pull request row");
    const [text, react, row, entry] = site;
    const replaced =
      `((props,key)=>globalThis.${ROW_GLOBAL}?.(props,key)??(0,${react}.jsx)(${row},props,key))` +
      `({link:${entry}.link,number:${entry}.link.number,url:${entry}.link.url,title:`;
    return { applied: true, source: source.slice(0, site.index) + replaced + source.slice(site.index + text.length) };
  } catch (error) {
    return { applied: false, source, problem: error.message };
  }
}

module.exports = { ROW_GLOBAL, patchCardRows, patchMainRows, pullRequestRow };

"use strict";

const ID = "[\\w$]+";
const RIGHT = "side:`right`";
const MIRRORED = 'side:(document.documentElement.getAttribute("data-t3-rtl-app")==="on"?`left`:`right`)';

const SITES = [
  new RegExp(`side:\`right\`,render:\\(0,${ID}\\.jsx\\)\\(\`button\`,\\{type:\`button\`,"aria-label":${ID}\\(\`(?:Un-s|S)ettle thread\`\\)`, "g"),
  new RegExp(`onOpenPullRequest:${ID},side:\`right\`\\}`, "g"),
  new RegExp(`side:\`right\`,children:\\[\\(0,${ID}\\.jsx\\)\\(${ID},\\{links:[^{}]*?mountScope:\`sidebar-tooltip\``, "g"),
];

function patchSidebarPopups(source) {
  const places = SITES.flatMap((site) => [...source.matchAll(site)].map((match) => match.index + match[0].indexOf(RIGHT)));
  if (places.length === 0) return { applied: false, source, problem: "no popup of a sidebar row opens to the right" };
  let patched = "";
  let cursor = 0;
  for (const place of places.sort((a, b) => a - b)) {
    patched += source.slice(cursor, place) + MIRRORED;
    cursor = place + RIGHT.length;
  }
  return { applied: true, source: patched + source.slice(cursor) };
}

module.exports = { patchSidebarPopups };

"use strict";

// Rewrites T3 Code's CSS for the right-to-left layout. Each physical left or
// right declaration becomes its logical start or end equivalent, so the same
// rule mirrors under dir="rtl" and keeps T3 Code's layout under dir="ltr".
// Only property names are renamed, in place, so the order of declarations,
// their priority, and values that use var() stay exactly as T3 Code wrote
// them. The page runs this function as source text, so it must not use
// anything outside its own body.
function mirrorCss(text, options) {
  const baseUrl = options && typeof options.baseUrl === "string" ? options.baseUrl : null;

  const NAMES = {
    "margin-left": "margin-inline-start",
    "margin-right": "margin-inline-end",
    "padding-left": "padding-inline-start",
    "padding-right": "padding-inline-end",
    "scroll-margin-left": "scroll-margin-inline-start",
    "scroll-margin-right": "scroll-margin-inline-end",
    "scroll-padding-left": "scroll-padding-inline-start",
    "scroll-padding-right": "scroll-padding-inline-end",
    left: "inset-inline-start",
    right: "inset-inline-end",
    "border-left": "border-inline-start",
    "border-right": "border-inline-end",
    "border-left-width": "border-inline-start-width",
    "border-right-width": "border-inline-end-width",
    "border-left-style": "border-inline-start-style",
    "border-right-style": "border-inline-end-style",
    "border-left-color": "border-inline-start-color",
    "border-right-color": "border-inline-end-color",
    "border-top-left-radius": "border-start-start-radius",
    "border-top-right-radius": "border-start-end-radius",
    "border-bottom-left-radius": "border-end-start-radius",
    "border-bottom-right-radius": "border-end-end-radius",
  };
  // Four sided shorthands: top right bottom left, or for radii top-left
  // top-right bottom-right bottom-left.
  const BOXES = {
    margin: ["margin-block", "margin-inline"],
    padding: ["padding-block", "padding-inline"],
    inset: ["inset-block", "inset-inline"],
    "scroll-margin": ["scroll-margin-block", "scroll-margin-inline"],
    "scroll-padding": ["scroll-padding-block", "scroll-padding-inline"],
    "border-width": ["border-block-width", "border-inline-width"],
    "border-style": ["border-block-style", "border-inline-style"],
    "border-color": ["border-block-color", "border-inline-color"],
  };
  const LISTS = new Set(["transition", "transition-property", "will-change"]);
  // The space for the window's own title bar area stays where it is.
  const KEEP_VALUE = /titlebar-area|--desktop-window-|--toast-/;
  // Notifications are placed, animated, and swiped by T3 Code from the
  // pointer's physical movement, so their rules stay as they are.
  const KEEP_PRELUDE = /data-position|data-swipe-direction|toast/i;
  // --t3-rtl-x is -1 in a right-to-left box and 1 in a left-to-right one
  // (see app-layout.js), so a value can follow the side a box lands on by
  // arithmetic.
  const ltrOnly = "(1 + var(--t3-rtl-x, 1)) / 2";
  const rtlOnly = "(1 - var(--t3-rtl-x, 1)) / 2";
  // A mirrored side takes the window inset of the side it lands on.
  const swapSides = (value) =>
    value
      .replace(/(var\(--workspace-controls-|env\(safe-area-inset-)(left|right)\)/g, (match, prefix, side) => {
        const other = prefix + (side === "left" ? "right" : "left") + ")";
        return `calc(${match} * ${ltrOnly} + ${other} * ${rtlOnly})`;
      })
      // The window's own buttons stay in its top right corner. A header that
      // keeps room for them at its end needs it only while that end is the
      // right: in the mirrored layout the sidebar is under the buttons.
      .replace(/var\(--workspace-native-controls-inset\)/g, (match) => `calc(${match} * ${ltrOnly})`)
      // The room kept beside the sidebar's own buttons grows by the window's
      // buttons when those sit on the same side, in the mirrored layout.
      .replace(/var\(--workspace-titlebar-content-left\)/g, (match) =>
        `calc(${match} + (var(--workspace-controls-right) - var(--workspace-controls-left)) * ${rtlOnly})`);
  // Anything that a split by whitespace cannot read safely.
  const OPAQUE = /var\(|env\(|calc\(|attr\(|\//;

  let changed = 0;
  let imports = false;

  const splitTop = (value) => {
    const parts = [];
    let depth = 0;
    let current = "";
    let quote = null;
    for (let i = 0; i < value.length; i++) {
      const c = value[i];
      if (quote) {
        current += c;
        if (c === "\\" && i + 1 < value.length) current += value[++i];
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
      if (depth === 0 && /\s/.test(c)) {
        if (current) parts.push(current);
        current = "";
        continue;
      }
      current += c;
    }
    if (current) parts.push(current);
    return parts;
  };

  const splitPriority = (value) => {
    const match = /\s*!\s*important\s*$/i.exec(value);
    return match ? [value.slice(0, match.index), match[0]] : [value, ""];
  };

  const rewriteBox = (name, value) => {
    const [body, priority] = splitPriority(value);
    if (OPAQUE.test(body)) return null;
    const parts = splitTop(body.trim());
    if (parts.length !== 4) return null;
    const [top, right, bottom, left] = parts;
    if (right === left) return null;
    const [block, inline] = BOXES[name];
    return `${block}:${top} ${bottom}${priority};${inline}:${left} ${right}${priority}`;
  };

  const rewriteRadius = (value) => {
    const [body, priority] = splitPriority(value);
    if (OPAQUE.test(body)) return null;
    const parts = splitTop(body.trim());
    if (parts.length !== 4) return null;
    const [topLeft, topRight, bottomRight, bottomLeft] = parts;
    if (topLeft === topRight && bottomLeft === bottomRight) return null;
    return (
      `border-start-start-radius:${topLeft}${priority};border-start-end-radius:${topRight}${priority};` +
      `border-end-end-radius:${bottomRight}${priority};border-end-start-radius:${bottomLeft}${priority}`
    );
  };

  // A transition or will-change list names properties. A physical name keeps
  // its place and its logical twin follows it, so the animation still runs
  // whether the side was mirrored or kept physical by an exception. Each
  // transition segment is copied whole, with its duration and easing.
  const splitCommas = (value) => {
    const parts = [];
    let depth = 0;
    let current = "";
    for (const c of value) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (c === "," && depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
      current += c;
    }
    parts.push(current);
    return parts;
  };

  const rewriteList = (name, value) => {
    const [body, priority] = splitPriority(value);
    if (/var\(/.test(body)) return value;
    const segments = splitCommas(body);
    const next = [];
    let added = false;
    for (const segment of segments) {
      next.push(segment);
      const property = segment.trim().split(/\s+/)[0].toLowerCase();
      if (!NAMES[property]) continue;
      const twin = segment.replace(/^(\s*)\S+/, (match, space) => space + NAMES[property]);
      next.push(name === "transition" ? twin : twin.trim());
      added = true;
    }
    return added ? next.join(",") + priority : value;
  };

  // A url() token: quoted, where the address may hold parentheses, or bare.
  const URL_TOKEN = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^"'()\s]+))\s*\)/gi;
  const absoluteUrls = (value) => {
    if (!baseUrl || !/url\(/i.test(value)) return value;
    return value.replace(URL_TOKEN, (match, double, single, bare) => {
      const url = double ?? single ?? bare;
      const quote = double !== undefined ? '"' : single !== undefined ? "'" : "";
      // An address with a CSS escape stays as written: resolving it would
      // need the escape decoded first.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url) || url.includes("\\")) return match;
      try {
        return `url(${quote}${new URL(url, baseUrl).href}${quote})`;
      } catch {
        return match;
      }
    });
  };

  // One declaration, as written between the start of the statement and its
  // ";" or "}". Leading whitespace and comments are kept.
  const rewriteDeclaration = (statement) => {
    const colon = statement.indexOf(":");
    if (colon === -1) return statement;
    const head = statement.slice(0, colon);
    const name = head.trim().toLowerCase();
    // Tailwind moves an element sideways through this variable. A mirrored
    // element moves the other way, such as one centered from its new side or
    // a switch thumb that starts on the right. The layout sets --t3-rtl-x to
    // -1 in right-to-left boxes and to 1 in left-to-right islands and where a
    // script places an element from its physical side.
    if (name === "--tw-translate-x") {
      const [body, priority] = splitPriority(statement.slice(colon + 1));
      if (!body.trim() || /^\s*0(?:px)?\s*$/.test(body)) return statement;
      changed++;
      return head + ":calc(var(--t3-rtl-x, 1) * (" + body.trim() + "))" + priority;
    }
    if (!name || name.startsWith("--")) return statement;
    // A mirrored arrow icon turns the other way, so an open chevron that T3
    // Code rotates to point down still points down. The layout sets the
    // variable to -1 only on the icons it mirrors.
    if (name === "rotate") {
      const [body, priority] = splitPriority(statement.slice(colon + 1));
      const angle = body.trim();
      if (/^-?[\d.]+(?:deg|turn|rad|grad)$/i.test(angle)) {
        changed++;
        return head + ":calc(" + angle + " * var(--t3-rtl-turn, 1))" + priority;
      }
      return statement;
    }
    const lead = head.slice(0, head.length - head.trimStart().length);
    const value = statement.slice(colon + 1);
    // Text inside a string of generated content is not an address, while an
    // image it names with url() is.
    let nextValue = name === "content"
      ? value.replace(new RegExp(URL_TOKEN.source + /|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/.source, "gi"),
        (part) => (/^url\(/i.test(part) ? absoluteUrls(part) : part))
      : absoluteUrls(value);
    const unchanged = () => (nextValue === value ? statement : head + ":" + nextValue);
    if (KEEP_VALUE.test(nextValue)) return unchanged();
    if (NAMES[name]) {
      changed++;
      return lead + NAMES[name] + ":" + swapSides(nextValue);
    }
    if (name === "text-align") {
      const [body, priority] = splitPriority(nextValue);
      const align = body.trim().toLowerCase();
      if (align === "left" || align === "right") {
        changed++;
        return `${lead}text-align:${align === "left" ? "start" : "end"}${priority}`;
      }
    }
    if (BOXES[name]) {
      const box = rewriteBox(name, nextValue);
      if (box) {
        changed++;
        return lead + box;
      }
    }
    if (name === "border-radius") {
      const radius = rewriteRadius(nextValue);
      if (radius) {
        changed++;
        return lead + radius;
      }
    }
    if (LISTS.has(name)) {
      const list = rewriteList(name, nextValue);
      if (list !== nextValue) {
        changed++;
        nextValue = list;
      }
    }
    return unchanged();
  };

  // Walks the text statement by statement. A statement that ends with "{"
  // opens a rule or at-rule block, one that ends with ";" or "}" inside a
  // block is a declaration. Strings, comments and parentheses are skipped
  // over so their contents never end a statement.
  // A statement without its comments, for telling what kind it is.
  const bare = (part) => part.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  let output = "";
  let statement = "";
  const keepStack = [];
  let depth = 0;
  let parens = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    // An escaped character, such as "\(" in a Tailwind class name, is text.
    if (c === "\\") {
      statement += text.slice(i, i + 2);
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      statement += text.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === "\\") j++;
        j++;
      }
      statement += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(") parens++;
    if (c === ")" && parens > 0) parens--;
    if (parens > 0) {
      statement += c;
      continue;
    }
    if (c === "{") {
      const prelude = statement;
      if (/^@import\b/i.test(bare(prelude))) imports = true;
      // Declarations directly inside @font-face, @page and similar at-rules
      // describe something other than a box.
      const keep = (keepStack.length > 0 && keepStack[keepStack.length - 1]) ||
        /^\s*@(?:font-face|page|property|counter-style|font-feature-values)\b/i.test(prelude) ||
        KEEP_PRELUDE.test(prelude);
      keepStack.push(keep);
      depth++;
      output += prelude + c;
      statement = "";
      continue;
    }
    if (c === ";" || c === "}") {
      const keep = keepStack.length > 0 && keepStack[keepStack.length - 1];
      const plain = bare(statement);
      if (/^@import\b/i.test(plain)) imports = true;
      const isDeclaration = depth > 0 && !/^@/.test(plain) && plain !== "";
      output += isDeclaration && !keep ? rewriteDeclaration(statement) : statement;
      output += c;
      statement = "";
      if (c === "}") {
        keepStack.pop();
        if (depth > 0) depth--;
      }
      continue;
    }
    statement += c;
  }
  output += statement;
  return { css: output, changed, imports };
}

module.exports = { mirrorCss };

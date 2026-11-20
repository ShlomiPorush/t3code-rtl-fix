"use strict";

// A chat width between T3 Code's own Comfortable and Wide, which the Extras
// section sets. T3 Code limits messages and the composer to
// --chat-content-max-width: 46rem for Comfortable, 72rem for Wide, and the
// whole lane for Full. The chosen width replaces only Comfortable, so Wide
// and Full in T3 Code's settings still work as T3 Code made them.

// The widths the Extras section offers, in rem. null is T3 Code's own.
const CHAT_WIDTHS = Object.freeze([52, 58, 64]);

const STYLE_ID = "t3-rtl-chat-width";

function isChatWidth(value) {
  return value === null || CHAT_WIDTHS.includes(value);
}

function chatWidthCss(width) {
  if (!CHAT_WIDTHS.includes(width)) return "";
  return `:root:not([data-chat-width="wide"], [data-chat-width="full"]) { --chat-content-max-width: ${width}rem; }`;
}

// Runs in each new document and in an open page when the setting changes.
// It adds, changes, or removes one style element of its own.
function buildChatWidthSource(width) {
  const css = chatWidthCss(width);
  return `(() => {
  if (window.top !== window) return;
  const id = ${JSON.stringify(STYLE_ID)};
  const css = ${JSON.stringify(css)};
  const apply = () => {
    let style = document.getElementById(id);
    if (!css) {
      if (style) style.remove();
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.id = id;
      document.documentElement.appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
  };
  if (document.documentElement) {
    apply();
    return;
  }
  // A new document gets this script before it has a root element.
  const waiter = new MutationObserver(() => {
    if (!document.documentElement) return;
    waiter.disconnect();
    apply();
  });
  waiter.observe(document, { childList: true });
})();`;
}

module.exports = { CHAT_WIDTHS, isChatWidth, chatWidthCss, buildChatWidthSource };

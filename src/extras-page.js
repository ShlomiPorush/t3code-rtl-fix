"use strict";

// The page side of Extras: the usage chips in the sidebar footer, with the
// version of the fix in their list, and the Extras section on T3 Code's Labs
// settings page. It runs in an isolated
// world that the launcher creates in the main frame, so T3 Code's own scripts
// and the frames inside the page cannot reach its binding or its receiver.
//
// pageMain is not called here. It is turned into source text and evaluated
// in the page, so it may use only what it gets in config.

/* eslint-disable no-var */
function pageMain(config) {
  "use strict";
  if (window !== window.top || location.protocol !== config.protocol) return;
  // The launcher can start the script again in a world that already runs it,
  // with a new receiver name. The running copy takes the new name and checks.
  var flagName = "__t3ExtrasStarted";
  if (typeof window[flagName] === "function") {
    window[flagName](config);
    return;
  }
  Object.defineProperty(window, flagName, { value: rebind });

  var STRIP = "data-t3-extras-usage";
  var POP = "data-t3-extras-usage-pop";
  var SECTION = "data-t3-extras-settings";
  var STYLE_ID = "t3-extras-style";
  // The copy that started last owns the page. A copy in an older world, if
  // Chromium kept one, sees another owner and stops.
  var OWNER = "data-t3-extras-owner";
  var retired = false;
  var timers = [];
  // The nodes this copy made. Nodes of an older copy carry its listeners,
  // so they are replaced.
  var mine = new WeakSet();

  var state = {
    settings: null,
    accounts: [],
    repoStatusAvailable: false,
    problem: null,
    error: null,
    busy: false,
    update: null,
  };

  function claim() {
    if (document.documentElement) document.documentElement.setAttribute(OWNER, config.receiver);
  }

  // A copy that started before the page had its root element claims it on
  // its first look, unless another copy already did.
  function owns() {
    var root = document.documentElement;
    if (retired || !root) return false;
    if (!root.hasAttribute(OWNER)) root.setAttribute(OWNER, config.receiver);
    return root.getAttribute(OWNER) === config.receiver;
  }

  // A message sent before the page has its root element waits for it.
  var waiting = null;
  function notify(message) {
    if (!document.documentElement) {
      waiting = message;
      return;
    }
    if (!owns()) return;
    var call = window[config.binding];
    if (typeof call === "function") call(JSON.stringify(message));
  }

  function route() {
    try {
      var url = new URL(location.href);
      return url.hash.indexOf("#/") === 0 ? url.hash.slice(1).split("?")[0] : url.pathname;
    } catch (error) {
      return "";
    }
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(className, path) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", className);
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.appendChild(document.createElementNS(ns, "path")).setAttribute("d", path);
    return svg;
  }

  // Each account shows in its own color from T3 Code, as #rrggbb, or in the
  // muted text color when it has none.
  function tint(node, account) {
    node.style.setProperty("--t3x-accent", account.accent || "var(--muted-foreground)");
    return node;
  }

  function busiest(account) {
    var best = null;
    for (var i = 0; i < account.windows.length; i++) {
      if (!best || account.windows[i].usedPercent > best.usedPercent) best = account.windows[i];
    }
    return best;
  }

  function shownAccounts() {
    var settings = state.settings;
    if (!settings || !settings.usageLimits) return [];
    var hidden = new Set(settings.usageHiddenAccounts || []);
    return state.accounts.filter(function (account) {
      return !hidden.has(account.id) && account.windows.length > 0;
    });
  }

  function ago(time) {
    var minutes = Math.max(0, Math.round((Date.now() - time) / 60000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + " min ago";
    var hours = Math.floor(minutes / 60);
    return hours + " h ago";
  }

  // How long until a reset, in words: "in 21h", "in 1d 14h", "in 35m".
  function until(time) {
    var minutes = Math.max(0, Math.round((time - Date.now()) / 60000));
    if (minutes < 60) return "in " + minutes + "m";
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return "in " + hours + "h" + (minutes % 60 ? " " + (minutes % 60) + "m" : "");
    var days = Math.floor(hours / 24);
    return "in " + days + "d" + (hours % 24 ? " " + (hours % 24) + "h" : "");
  }

  // The reset in words, with its date and time on pointing at it.
  function resetNode(time, className, short) {
    var node = el("span", className, (short ? "" : "resets ") + until(time));
    var date = new Date(time);
    node.title = date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) + ", " +
      date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
    return node;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID) || !document.head) return;
    var style = el("style");
    style.id = STYLE_ID;
    style.textContent = config.css;
    document.head.appendChild(style);
  }

  // ---- Version of the fix -------------------------------------------------

  var ICONS = {
    refresh: "M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5",
    download: "M12 15V3M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5",
    check: "M20 6 9 17l-5-5",
    warning: "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4M12 17h.01",
  };

  function updateAction() {
    var status = state.update.status;
    if (status === "checking") return { label: "Checking…", icon: "refresh", type: null };
    if (status === "installing") return { label: "Installing…", icon: "refresh", type: null };
    if (status === "available") return { label: "Install", icon: "download", type: "installUpdate" };
    if (status === "installFailed") return { label: "Try again", icon: "download", type: "installUpdate" };
    return { label: "Check for Updates", icon: "refresh", type: "checkUpdate" };
  }

  var settledText = "The version of t3code-rtl-fix that is installed.";

  // While a check or an install runs, the text of the last result stays.
  function updateText() {
    var update = state.update;
    switch (update.status) {
      case "current": return "Up to date.";
      case "available": return "Version " + update.latest + " is available. Installing it reloads T3 Code's windows. Running sessions keep running.";
      case "checkFailed": return "Could not check for updates. Check your connection and try again.";
      case "installed": return "Version " + update.installed + " is installed. The windows reload in a few seconds. If they do not, quit T3 Code and open it again.";
      case "installFailed": return "The update was not installed. The reason is in launcher.log. You can also run the install command again.";
      default: return settledText;
    }
  }

  function updateName() {
    return "RTL Fix" + (state.update.installed ? " " + state.update.installed : "");
  }

  var MARKS = {
    current: { icon: "check", tone: "success", label: "Up to date" },
    installed: { icon: "check", tone: "success", label: "Installed" },
    checkFailed: { icon: "warning", tone: "warning", label: "Check failed" },
    installFailed: { icon: "warning", tone: "destructive", label: "Update failed" },
  };

  // The version in the usage list, on one line: icons in place of words.
  function updateSummary() {
    var update = state.update;
    var offered = update.status === "available" || update.status === "installing";
    var summary = el("span", "t3x-pop-version");
    summary.appendChild(el("span", "", updateName() + (offered ? " → " + update.latest : "")));
    var mark = MARKS[update.status];
    if (mark) {
      var node = el("span", "t3x-mark");
      node.setAttribute("role", "img");
      node.setAttribute("aria-label", mark.label);
      node.title = mark.label;
      node.style.color = "var(--" + mark.tone + ")";
      node.appendChild(icon("t3x-icon", ICONS[mark.icon]));
      summary.appendChild(node);
    }
    return summary;
  }

  // Each action gets a button of its own, so a press on "Check" that is released
  // after an update was found never installs it. A button that is disabled
  // would lose the focus.
  function updateButton(className, iconOnly) {
    var action = updateAction();
    var button = el("button", className, iconOnly ? "" : action.label);
    button.type = "button";
    if (iconOnly) {
      button.setAttribute("aria-label", action.label);
      button.title = action.label;
      button.dataset.icon = action.icon;
      button.appendChild(icon("t3x-icon", ICONS[action.icon]));
    }
    button.setAttribute("aria-disabled", action.type ? "false" : "true");
    // A key that is held on "Check" reaches the "Install" that takes its place.
    button.addEventListener("keydown", function (event) {
      if (event.repeat && (event.key === "Enter" || event.key === " ")) event.preventDefault();
    });
    button.addEventListener("click", function (event) {
      if (event.isTrusted && action.type) notify({ type: action.type });
    });
    return button;
  }

  // ---- Footer chips -------------------------------------------------------

  var popover = null;
  var popBody = null;
  var popFoot = null;
  var signatures = new WeakMap();
  var popAnchor = null;
  var showTimer = 0;
  var hideTimer = 0;

  function footerRow(footer) {
    var buttons = footer.querySelectorAll("button");
    if (buttons.length < 2) return null;
    // The row is the closest element that holds the last two buttons. In T3
    // Code it is the menu list of the control buttons, whose last item, the
    // update button, sits at the far end, so the chips go just before that
    // item. A notice with its own button above the row, such as a provider
    // update, is not part of it.
    var last = buttons[buttons.length - 1];
    var menu = last.closest('[data-slot="sidebar-menu"]');
    var first = menu && footer.contains(menu) && menu !== last ? null : buttons[buttons.length - 2];
    var row = menu && first === null ? menu : last.parentElement;
    while (first && row && row !== footer && !row.contains(first)) row = row.parentElement;
    if (!row || row === last) return null;
    var before = last;
    while (before.parentElement !== row) before = before.parentElement;
    return { row: row, before: before };
  }

  // T3 Code's pace: the part of the window used, against the part that has
  // passed. More than 5 points over is ahead, more than 5 under is under.
  var PACE = {
    blocked: { label: "Limit reached", path: "M12 3a9 9 0 1 0 0.01 0 M5.6 5.6l12.8 12.8" },
    ahead: { label: "Ahead of pace", path: "M12 19V5 M5 12l7-7 7 7" },
    on: { label: "On pace", path: "M5 12h14 M12 5l7 7-7 7" },
    under: { label: "Under pace", path: "M12 5v14 M19 12l-7 7-7-7" },
  };

  function pace(window) {
    // A limit that is used up shows as blocked, whatever the pace.
    if (window.usedPercent >= 100) return "blocked";
    if (!window.resetsAt || !window.windowDurationMins) return null;
    var length = window.windowDurationMins * 60000;
    var elapsed = Math.max(0, Math.min(1, (length - (window.resetsAt - Date.now())) / length));
    var gap = window.usedPercent - elapsed * 100;
    return gap > 5 ? "ahead" : gap < -5 ? "under" : "on";
  }

  // An arrow for the pace, in the account's color, or the account's dot when
  // the window has no pace.
  function paceMark(window) {
    var kind = pace(window);
    if (!kind) return el("span", "t3x-dot");
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "t3x-pace");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("data-pace", kind);
    var path = document.createElementNS(ns, "path");
    path.setAttribute("d", PACE[kind].path);
    svg.appendChild(path);
    var title = document.createElementNS(ns, "title");
    title.textContent = PACE[kind].label;
    svg.appendChild(title);
    return svg;
  }

  function summaryLabel(accounts) {
    return "Usage limits: " + accounts.map(function (account) {
      var top = busiest(account);
      var kind = top ? pace(top) : null;
      return account.name + " " + (top ? top.usedPercent : 0) + "%" + (kind ? ", " + PACE[kind].label.toLowerCase() : "");
    }).join("; ");
  }

  function chip(account) {
    var top = busiest(account);
    var node = tint(el("span", "t3x-chip"), account);
    node.appendChild(paceMark(top));
    node.appendChild(el("span", "t3x-pct", top.usedPercent + "%"));
    return node;
  }

  // Shows the busiest accounts, as many as the free width holds, so a wider
  // sidebar shows more of them.
  function fill(strip, accounts) {
    var ranked = accounts.slice().sort(function (a, b) {
      return busiest(b).usedPercent - busiest(a).usedPercent;
    });
    var inner = strip.firstChild;
    inner.textContent = "";
    strip.style.visibility = "";
    for (var i = 0; i < ranked.length; i++) {
      var next = chip(ranked[i]);
      inner.appendChild(next);
      if (inner.scrollWidth > strip.clientWidth) {
        inner.removeChild(next);
        break;
      }
    }
    if (!inner.firstChild) strip.style.visibility = "hidden";
  }

  function renderStrip() {
    var accounts = shownAccounts();
    var onSettings = route().indexOf("/settings") === 0;
    var footers = onSettings || !accounts.length ? [] : document.querySelectorAll('[data-slot="sidebar-footer"]');
    var keep = null;
    for (var i = 0; i < footers.length && !keep; i++) {
      var place = footerRow(footers[i]);
      if (!place) continue;
      var list = place.row.tagName === "UL" || place.row.tagName === "OL";
      var host = place.row.querySelector(":scope > [" + STRIP + "]");
      if (host && (host.tagName !== (list ? "LI" : "DIV") || !mine.has(host))) {
        host.remove();
        host = null;
      }
      if (!host) {
        host = el(list ? "li" : "div", "t3x-host");
        mine.add(host);
        host.setAttribute(STRIP, "");
        var button = el("button", "t3x-strip");
        button.type = "button";
        button.appendChild(el("span", "t3x-strip-inner"));
        host.appendChild(button);
        wireStrip(button);
        // A sidebar that is resized changes the room for the chips.
        if (typeof ResizeObserver === "function") new ResizeObserver(schedule).observe(host);
      }
      if (host.nextSibling !== place.before || host.parentElement !== place.row) place.row.insertBefore(host, place.before);
      var strip = host.firstChild;
      // Only a change of the data or of the free width rebuilds the chips,
      // so the strip's own changes do not start another render.
      // The signature stays in this world, out of the shared page.
      var signature = JSON.stringify([accounts, strip.clientWidth]);
      if (signatures.get(strip) !== signature) {
        strip.setAttribute("aria-label", summaryLabel(accounts));
        fill(strip, accounts);
        signatures.set(strip, JSON.stringify([accounts, strip.clientWidth]));
        if (popover && popAnchor === strip) buildPop(strip);
      }
      keep = host;
    }
    var all = document.querySelectorAll("[" + STRIP + "]");
    for (var j = 0; j < all.length; j++) if (all[j] !== keep) all[j].remove();
    // A popover of a button that React replaced closes with it.
    if (!keep || (popAnchor && !popAnchor.isConnected)) hidePop();
  }

  function buildPop(anchor) {
    var accounts = shownAccounts();
    var scrolled = popover ? popover.scrollTop : 0;
    if (!popover) {
      popover = el("div", "t3x-pop");
      popover.setAttribute(POP, "");
      popover.setAttribute("role", "dialog");
      popover.setAttribute("aria-label", "Usage limits");
      popover.id = "t3-extras-usage-pop";
      popBody = el("div");
      popover.appendChild(popBody);
      popFoot = buildPopFoot();
      popover.appendChild(popFoot);
      popover.addEventListener("mouseenter", function () {
        clearTimeout(hideTimer);
      });
      popover.addEventListener("mouseleave", scheduleHide);
    }
    popBody.textContent = "";
    var head = el("div", "t3x-pop-head");
    head.appendChild(el("span", "t3x-pop-title", "Usage limits"));
    popBody.appendChild(head);
    var list = el("div", "t3x-pop-list");
    accounts.forEach(function (account) {
      var row = tint(el("div", "t3x-acct" + (Date.now() - account.checkedAt > config.dimAfterMs ? " t3x-old" : "")), account);
      // One reset for all the limits of the account, as with Claude, shows
      // once on the title line. Different resets show on their own lines.
      var resets = {};
      account.windows.forEach(function (window) {
        if (window.resetsAt) resets[Math.round(window.resetsAt / 60000)] = window.resetsAt;
      });
      var resetTimes = Object.keys(resets).map(function (key) {
        return resets[key];
      });
      var shared = resetTimes.length === 1 && account.windows.every(function (window) {
        return !!window.resetsAt;
      }) ? resetTimes[0] : null;
      var title = el("div", "t3x-acct-head");
      var name = el("span", "t3x-acct-name", account.name);
      name.insertBefore(el("span", "t3x-dot"), name.firstChild);
      name.dir = "auto";
      // When T3 Code last checked the account, on pointing at its name.
      name.title = "Checked " + ago(account.checkedAt);
      title.appendChild(name);
      if (shared) title.appendChild(resetNode(shared, "t3x-reset"));
      row.appendChild(title);
      // Each limit has its own line, such as a separate limit of one model.
      account.windows.forEach(function (window) {
        var line = el("div", "t3x-window-line");
        var label = el("span", "t3x-window-label", window.label);
        if (!shared && window.resetsAt) {
          label.appendChild(document.createTextNode(" · "));
          label.appendChild(resetNode(window.resetsAt, "", true));
        }
        line.appendChild(label);
        var bar = el("span", "t3x-bar");
        var fillBar = el("i");
        fillBar.style.width = window.usedPercent + "%";
        bar.appendChild(fillBar);
        line.appendChild(bar);
        line.appendChild(el("span", "t3x-pct", window.usedPercent + "%"));
        var mark = el("span", "t3x-pace-cell");
        if (pace(window)) mark.appendChild(paceMark(window));
        line.appendChild(mark);
        row.appendChild(line);
      });
      list.appendChild(row);
    });
    popBody.appendChild(list);
    renderPopFoot();
    if (!popover.isConnected) document.body.appendChild(popover);
    place(anchor);
    // A refresh keeps the place the reader scrolled to.
    popover.scrollTop = scrolled;
  }

  // The version line stays when the list is drawn again, so its button keeps
  // the focus.
  var footSignature = "";
  function buildPopFoot() {
    var foot = el("div", "t3x-pop-foot");
    foot.hidden = true;
    foot.appendChild(el("span"));
    foot.appendChild(el("button"));
    foot.addEventListener("keydown", function (event) {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      var anchor = popAnchor;
      if (event.key === "Escape" || event.shiftKey) event.preventDefault();
      event.stopPropagation();
      // From the chips, Tab moves on to what follows them.
      if (anchor) anchor.focus();
      if (event.key === "Escape" || !event.shiftKey) hidePop();
    });
    foot.addEventListener("focusout", function (event) {
      // Closing the list takes the focus out of it as well.
      if (popAnchor && !popover.contains(event.relatedTarget) && event.relatedTarget !== popAnchor) hidePop();
    });
    return foot;
  }

  function renderPopFoot() {
    var signature = JSON.stringify(state.update);
    if (!state.update || signature === footSignature) return;
    footSignature = signature;
    popFoot.hidden = false;
    popFoot.firstChild.replaceWith(updateSummary());
    var previous = popFoot.lastChild;
    var button = updateButton("t3x-pop-btn", true);
    popFoot.appendChild(button);
    // Before the removal, which would take the focus out of the list and close it.
    if (document.activeElement === previous) button.focus({ preventScroll: true });
    previous.remove();
  }

  function place(anchor) {
    var rect = anchor.getBoundingClientRect();
    var width = popover.offsetWidth;
    // The list opens from the chips' start edge: the left one, or the right
    // one in the right-to-left layout.
    var start = document.documentElement.getAttribute("data-t3-rtl-app") === "on" ? rect.right - width : rect.left;
    var left = Math.max(8, Math.min(start, window.innerWidth - width - 8));
    popover.style.left = left + "px";
    popover.style.bottom = Math.max(8, window.innerHeight - rect.top + 6) + "px";
    popover.style.maxHeight = Math.max(120, rect.top - 16) + "px";
  }

  // An open list is drawn again each half minute, so its ages and reset
  // times stay current.
  var popTimer = 0;
  function showPop(anchor) {
    clearTimeout(hideTimer);
    popAnchor = anchor;
    buildPop(anchor);
    clearInterval(popTimer);
    popTimer = setInterval(function () {
      if (popAnchor && popAnchor.isConnected) buildPop(popAnchor);
      else hidePop();
    }, 30000);
    anchor.setAttribute("aria-controls", popover.id);
    anchor.setAttribute("aria-expanded", "true");
    notify({ type: "updateShown" });
  }

  function hidePop() {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    clearInterval(popTimer);
    if (popAnchor) {
      popAnchor.removeAttribute("aria-controls");
      popAnchor.setAttribute("aria-expanded", "false");
    }
    popAnchor = null;
    if (popover && popover.isConnected) popover.remove();
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () {
      hidePop();
    }, 200);
  }

  function wireStrip(strip) {
    strip.setAttribute("aria-haspopup", "dialog");
    strip.setAttribute("aria-expanded", "false");
    strip.addEventListener("mouseenter", function () {
      clearTimeout(hideTimer);
      clearTimeout(showTimer);
      showTimer = setTimeout(function () {
        showPop(strip);
      }, 250);
    });
    strip.addEventListener("mouseleave", function () {
      clearTimeout(showTimer);
      scheduleHide();
    });
    strip.addEventListener("focus", function () {
      if (strip.matches(":focus-visible")) showPop(strip);
    });
    strip.addEventListener("blur", function (event) {
      if (!popover || !popover.contains(event.relatedTarget)) hidePop();
    });
    strip.addEventListener("click", function () {
      if (popAnchor === strip) hidePop();
      else showPop(strip);
    });
    // While the list is open, the arrow and page keys scroll it, so the
    // keyboard reaches every account without leaving the chips.
    var scrollKeys = { ArrowDown: 40, ArrowUp: -40, PageDown: 0.8, PageUp: -0.8 };
    strip.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && popAnchor) {
        event.stopPropagation();
        hidePop();
      } else if (event.key === "Tab" && !event.shiftKey && popAnchor === strip && !popFoot.hidden) {
        event.preventDefault();
        popFoot.lastChild.focus();
      } else if (popAnchor === strip && popover && (Object.prototype.hasOwnProperty.call(scrollKeys, event.key) || event.key === "Home" || event.key === "End")) {
        event.preventDefault();
        var step = scrollKeys[event.key];
        if (event.key === "Home") popover.scrollTop = 0;
        else if (event.key === "End") popover.scrollTop = popover.scrollHeight;
        else popover.scrollTop += Math.abs(step) < 1 ? step * popover.clientHeight : step;
      } else if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        showPop(strip);
      }
    });
  }

  // ---- Labs section -------------------------------------------------------

  var listbox = null;
  var listTrigger = null;

  function sw(on, disabled, label, onToggle) {
    var button = el("button", "t3x-switch");
    button.type = "button";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-checked", on ? "true" : "false");
    button.setAttribute("aria-label", label);
    button.disabled = !!disabled;
    button.appendChild(el("span", "t3x-knob"));
    button.addEventListener("click", function (event) {
      if (!event.isTrusted || button.disabled) return;
      onToggle(!on);
    });
    return button;
  }

  // One choice of several, as a row of buttons. The arrow keys move the
  // choice, toward the reading direction of the row.
  function segmented(label, choices, current, disabled, onChoose) {
    var group = el("div", "t3x-seg");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    var buttons = choices.map(function (choice) {
      var button = el("button", "t3x-seg-btn", choice.label);
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", choice.value === current ? "true" : "false");
      button.setAttribute("aria-label", choice.name);
      button.tabIndex = choice.value === current ? 0 : -1;
      button.disabled = !!disabled;
      button.addEventListener("click", function (event) {
        if (!event.isTrusted || button.disabled || choice.value === current) return;
        onChoose(choice.value);
      });
      group.appendChild(button);
      return button;
    });
    group.addEventListener("keydown", function (event) {
      var index = buttons.indexOf(document.activeElement);
      if (index < 0 || !event.isTrusted) return;
      var rtl = getComputedStyle(group).direction === "rtl";
      var step = 0;
      if (event.key === "ArrowDown" || event.key === (rtl ? "ArrowLeft" : "ArrowRight")) step = 1;
      else if (event.key === "ArrowUp" || event.key === (rtl ? "ArrowRight" : "ArrowLeft")) step = -1;
      if (!step) return;
      event.preventDefault();
      var nextIndex = (index + step + buttons.length) % buttons.length;
      buttons[nextIndex].focus();
      if (!buttons[nextIndex].disabled) onChoose(choices[nextIndex].value);
    });
    return group;
  }

  function settingRow(title, description, control) {
    var row = el("div", "t3x-row");
    var text = el("div", "t3x-row-text");
    text.appendChild(el("div", "t3x-row-title", title));
    if (description) text.appendChild(el("div", "t3x-row-desc", description));
    row.appendChild(text);
    row.appendChild(control);
    return row;
  }

  function errorText() {
    var problem = (state.settings && state.settings.problem) || state.error;
    if (problem === "unreadable-file") return "settings.json could not be read. Fix or delete it.";
    if (problem === "inside-t3-home") return "The settings file is inside T3 Code's data folder. Reinstall the fix in its own folder.";
    if (problem === "path-unverified") return "The fix could not check where its settings file is. Changes are not saved.";
    if (problem === "write-failed") return "The change could not be saved.";
    return "";
  }

  function change(message) {
    if (state.busy) return;
    state.busy = true;
    state.error = null;
    notify(message);
    renderSection();
  }

  function accountsLabel() {
    var listed = state.accounts;
    var hidden = new Set(state.settings.usageHiddenAccounts || []);
    var shown = listed.filter(function (account) {
      return !hidden.has(account.id);
    }).length;
    if (!listed.length) return "No accounts";
    return shown === listed.length ? "All accounts" : shown + " of " + listed.length + " accounts";
  }


  function closeList(returnFocus) {
    if (listbox && listbox.isConnected) listbox.remove();
    listbox = null;
    if (listTrigger) {
      listTrigger.setAttribute("aria-expanded", "false");
      if (returnFocus) listTrigger.focus();
    }
  }

  function openList(trigger, focusId) {
    closeList(false);
    listTrigger = trigger;
    var hidden = new Set(state.settings.usageHiddenAccounts || []);
    listbox = el("div", "t3x-list");
    listbox.setAttribute("role", "listbox");
    listbox.setAttribute("aria-multiselectable", "true");
    listbox.setAttribute("aria-label", "Accounts shown in the sidebar");
    listbox.id = "t3-extras-accounts";
    // A Map, so a provider named like an object property groups normally.
    var groups = new Map();
    state.accounts.forEach(function (account) {
      if (!groups.has(account.provider)) groups.set(account.provider, []);
      groups.get(account.provider).push(account);
    });
    var order = Array.from(groups.keys());
    var options = [];
    order.forEach(function (provider) {
      var group = el("div", "t3x-group");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", provider);
      group.appendChild(el("div", "t3x-group-title", provider));
      groups.get(provider).forEach(function (account) {
        var option = el("div", "t3x-option");
        option.setAttribute("role", "option");
        option.tabIndex = -1;
        option.setAttribute("aria-selected", hidden.has(account.id) ? "false" : "true");
        option.dataset.id = account.id;
        var box = el("span", "t3x-check");
        box.appendChild(icon("", "M20 6 9 17l-5-5"));
        option.appendChild(box);
        var name = el("span", "t3x-option-name", account.name);
        name.dir = "auto";
        option.appendChild(name);
        if (!account.windows.length) option.appendChild(el("span", "t3x-option-note", "No usage data"));
        option.addEventListener("click", function (event) {
          if (!event.isTrusted) return;
          toggle(option);
        });
        group.appendChild(option);
        options.push(option);
      });
      listbox.appendChild(group);
    });
    listbox.addEventListener("keydown", function (event) {
      var index = options.indexOf(document.activeElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        var next = index + (event.key === "ArrowDown" ? 1 : -1);
        if (options.length) options[(next + options.length) % options.length].focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        if (options.length) options[event.key === "Home" ? 0 : options.length - 1].focus();
      } else if ((event.key === " " || event.key === "Enter") && index >= 0) {
        event.preventDefault();
        if (event.isTrusted) toggle(options[index]);
      } else if (event.key === "Escape" || event.key === "Tab") {
        if (event.key === "Escape") event.preventDefault();
        event.stopPropagation();
        closeList(event.key === "Escape");
      }
    });
    trigger.setAttribute("aria-expanded", "true");
    trigger.parentElement.appendChild(listbox);
    // Opens upward when the room below the trigger, in the window and in the
    // scrolling settings page, is too short.
    var scroller = trigger.closest("[data-settings-page-scroll]");
    var bottom = Math.min(window.innerHeight, scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight);
    var triggerRect = trigger.getBoundingClientRect();
    if (triggerRect.bottom + 4 + listbox.offsetHeight > bottom - 8 && triggerRect.top - 4 - listbox.offsetHeight > 8) listbox.classList.add("t3x-up");
    // The focus returns to the same account, or to the first one.
    var target = options.find(function (option) {
      return option.dataset.id === focusId;
    }) || options[0];
    if (target) target.focus();
  }

  function toggle(option) {
    if (state.busy || !state.settings || !state.settings.writable) return;
    var shown = option.getAttribute("aria-selected") === "true";
    change({ type: "hideAccount", id: option.dataset.id, hidden: shown });
  }

  function buildSection() {
    var settings = state.settings;
    var section = el("section", "t3x-section");
    section.setAttribute(SECTION, "");
    section.setAttribute("aria-labelledby", "t3-extras-title");
    var head = el("div", "t3x-head");
    var title = el("h2", "t3x-title", "Extras");
    title.id = "t3-extras-title";
    head.appendChild(title);
    head.appendChild(el("p", "t3x-sub", "Added by t3code-rtl-fix. Not part of T3 Code."));
    section.appendChild(head);
    var card = el("div", "t3x-card");
    // The controls stay enabled during a change, so the focus stays on them;
    // change() ignores a second change until the answer arrives.
    var locked = !settings.writable;
    card.appendChild(settingRow(
      "Right-to-left layout",
      "Mirror the whole app: the sidebar on the right and the composer and panels right to left.",
      sw(settings.rtlLayout, locked, "Right-to-left layout", function (value) {
        change({ type: "set", key: "rtlLayout", value: value });
      }),
    ));
    var currentWidth = settings.chatWidth === undefined ? null : settings.chatWidth;
    card.appendChild(settingRow(
      "Chat width",
      "How wide messages and the composer grow, in pixels, between T3 Code's Comfortable (736) and Wide. Applies while Appearance › Chat width is Comfortable.",
      segmented("Chat width", [
        { value: null, label: "Default", name: "Chat width: T3 Code's default" },
        { value: 52, label: "832", name: "Chat width: 832 pixels" },
        { value: 58, label: "928", name: "Chat width: 928 pixels" },
        { value: 64, label: "1024", name: "Chat width: 1024 pixels" },
      ], currentWidth, locked, function (value) {
        change({ type: "set", key: "chatWidth", value: value });
      }),
    ));
    card.appendChild(settingRow(
      "Usage limits in the sidebar",
      "Show the usage of the chosen accounts in the sidebar footer.",
      sw(settings.usageLimits, locked, "Usage limits in the sidebar", function (value) {
        change({ type: "set", key: "usageLimits", value: value });
      }),
    ));
    var wrap = el("div", "t3x-select");
    var trigger = el("button", "t3x-trigger");
    trigger.type = "button";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", "t3-extras-accounts");
    // A change in progress keeps the list open; toggle() waits for it.
    trigger.disabled = !settings.writable || !settings.usageLimits || !state.accounts.length;
    trigger.appendChild(el("span", "", accountsLabel()));
    trigger.appendChild(icon("t3x-caret", "m6 9 6 6 6-6"));
    trigger.addEventListener("click", function (event) {
      if (!event.isTrusted) return;
      if (listbox) closeList(false);
      else openList(trigger, null);
    });
    trigger.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" && !trigger.disabled) {
        event.preventDefault();
        openList(trigger, null);
      }
    });
    wrap.appendChild(trigger);
    var accountsDesc = state.problem === "provider-list-unreadable"
      ? "Could not read T3 Code's provider list."
      : state.problem === "wsl-only"
        ? "Not available while T3 Code runs only in WSL."
        : state.problem === "desktop-settings-unreadable"
          ? "Could not read T3 Code's desktop settings."
          : "Choose the accounts shown in the sidebar.";
    card.appendChild(settingRow("Accounts", accountsDesc, wrap));
    card.appendChild(settingRow(
      "Repository status",
      state.repoStatusAvailable
        ? "Show issues, pull requests, alerts, and branches in the thread details card."
        : "Needs Node.js 22.12 or newer, or T3 Code's own runtime.",
      sw(settings.repoStatus && state.repoStatusAvailable, locked || !state.repoStatusAvailable, "Repository status", function (value) {
        change({ type: "set", key: "repoStatus", value: value });
      }),
    ));
    card.appendChild(settingRow(
      "Working section in the boring sidebar",
      "Show T3 Code's Working section with the boring sidebar, at the top above Pinned. Needs Sidebar › Working section on. A change reloads the window. Running sessions keep running.",
      sw(settings.boringWorkingShelf === true, locked, "Working section in the boring sidebar", function (value) {
        change({ type: "set", key: "boringWorkingShelf", value: value });
      }),
    ));
    card.appendChild(settingRow(
      "Done section in the boring sidebar",
      "Show threads that wait for your input, and threads that finished and that you have not opened since, in a Done section, below Working and above Pinned. A change reloads the window. Running sessions keep running.",
      sw(settings.boringDoneShelf === true, locked, "Done section in the boring sidebar", function (value) {
        change({ type: "set", key: "boringDoneShelf", value: value });
      }),
    ));
    card.appendChild(settingRow(
      "Plain pinned threads in the boring sidebar",
      "Show pinned threads as rows, like the threads in the project folders, instead of cards. A change reloads the window. Running sessions keep running.",
      sw(settings.boringPlainPinned === true, locked, "Plain pinned threads in the boring sidebar", function (value) {
        change({ type: "set", key: "boringPlainPinned", value: value });
      }),
    ));
    if (state.update) card.appendChild(updateRow());
    var message = errorText();
    if (message) {
      var error = el("p", "t3x-error", message);
      error.setAttribute("role", "status");
      card.appendChild(error);
    }
    section.appendChild(card);
    return section;
  }

  var rowSignature = "";

  function updateRow() {
    rowSignature = JSON.stringify(state.update);
    settledText = updateText();
    var row = settingRow(updateName(), settledText, updateButton("t3x-btn", false));
    row.classList.add("t3x-update-row");
    var status = state.update.status;
    var offered = status === "available" || status === "installing" || status === "installFailed";
    var notes = offered ? state.update.notes : [];
    if (notes.length) {
      row.firstChild.appendChild(el("div", "t3x-notes-title", "What's changed in " + state.update.latest));
      var list = el("ul", "t3x-notes");
      notes.forEach(function (note) {
        list.appendChild(el("li", "", note));
      });
      row.firstChild.appendChild(list);
    }
    return row;
  }

  // Only this row follows the update, so the rest of the section does not flash.
  function renderUpdateRow(section) {
    var previous = section.querySelector(".t3x-update-row");
    if (!previous || JSON.stringify(state.update) === rowSignature) return;
    var row = updateRow();
    previous.before(row);
    if (previous.contains(document.activeElement)) row.querySelector("button").focus({ preventScroll: true });
    previous.remove();
  }

  var sectionSignature = "";

  function renderSection() {
    var onLabs = route().indexOf("/settings/labs") === 0;
    var scroll = onLabs && state.settings ? document.querySelector("[data-settings-page-scroll]") : null;
    var container = scroll && scroll.firstElementChild;
    var existing = document.querySelectorAll("[" + SECTION + "]");
    if (!container) {
      for (var i = 0; i < existing.length; i++) existing[i].remove();
      closeList(false);
      sectionSignature = "";
      return;
    }
    var signature = JSON.stringify([state.settings, state.accounts.map(function (a) {
      return [a.id, a.name, a.provider, a.windows.length > 0];
    }), state.repoStatusAvailable, state.problem, state.error, !!state.update]);
    var current = container.querySelector(":scope > [" + SECTION + "]");
    if (current && !mine.has(current)) {
      current.remove();
      current = null;
    }
    for (var j = 0; j < existing.length; j++) if (existing[j] !== current) existing[j].remove();
    if (!current) notify({ type: "updateShown" });
    if (current && signature === sectionSignature && current === container.lastElementChild) {
      renderUpdateRow(current);
      return;
    }
    var focusedOption = listbox && listbox.contains(document.activeElement) && document.activeElement.dataset
      ? document.activeElement.dataset.id || ""
      : null;
    var hadFocus = current && current.contains(document.activeElement) ? document.activeElement.getAttribute("aria-label") || document.activeElement.className : null;
    closeList(false);
    var next = buildSection();
    mine.add(next);
    if (current) current.replaceWith(next);
    else container.appendChild(next);
    if (next !== container.lastElementChild) container.appendChild(next);
    sectionSignature = signature;
    var trigger = next.querySelector(".t3x-trigger");
    if (focusedOption !== null && trigger && !trigger.disabled) openList(trigger, focusedOption);
    else if (hadFocus) {
      var again = Array.prototype.find.call(next.querySelectorAll("button"), function (button) {
        return (button.getAttribute("aria-label") || button.className) === hadFocus;
      });
      if (again) again.focus({ preventScroll: true });
    }
  }

  // ---- Updates ------------------------------------------------------------

  var queued = false;
  function retire() {
    retired = true;
    observer.disconnect();
    timers.forEach(clearInterval);
    hidePop();
    closeList(false);
  }

  function render() {
    queued = false;
    // Before the root element exists there is nothing to own or draw yet.
    if (!document.documentElement) return;
    if (!owns()) {
      if (!retired) retire();
      return;
    }
    if (waiting) {
      var message = waiting;
      waiting = null;
      notify(message);
    }
    ensureStyle();
    renderStrip();
    if (popAnchor) renderPopFoot();
    renderSection();
  }
  function schedule() {
    if (queued || retired) return;
    queued = true;
    requestAnimationFrame(render);
  }

  function receive(data) {
    if (!data || typeof data !== "object") return false;
    if (data.settings) state.settings = data.settings;
    if (Array.isArray(data.accounts)) state.accounts = data.accounts;
    if (typeof data.repoStatusAvailable === "boolean") state.repoStatusAvailable = data.repoStatusAvailable;
    if ("problem" in data) state.problem = data.problem;
    if ("update" in data) state.update = data.update;
    if (data.kind === "result") {
      state.busy = false;
      state.error = data.ok ? null : data.error;
    } else if (data.settings && data.settings.writable && !data.settings.problem && state.error === "unreadable-file") {
      // A settings file fixed by hand clears the message of a failed change.
      state.error = null;
    }
    schedule();
    return true;
  }

  function register(name) {
    if (!Object.prototype.hasOwnProperty.call(window, name)) Object.defineProperty(window, name, { value: receive });
  }

  // A second start in the same world: the new receiver name, and a change
  // that waited for an answer under the old name is given up.
  function rebind(next) {
    if (retired) return;
    config = next;
    register(config.receiver);
    claim();
    state.busy = false;
    notify({ type: "check" });
  }

  register(config.receiver);
  claim();

  document.addEventListener("pointerdown", function (event) {
    if (listbox && !listbox.contains(event.target) && event.target !== listTrigger && !(listTrigger && listTrigger.contains(event.target))) {
      closeList(false);
    }
  }, true);
  window.addEventListener("resize", schedule);

  var observer = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var target = records[i].target;
      var element = target.nodeType === 1 ? target : target.parentElement;
      // Changes inside the add-on's own nodes do not need a render.
      if (element && element.closest("[" + STRIP + "], [" + POP + "], [" + SECTION + "]")) continue;
      schedule();
      return;
    }
  });
  observer.observe(document, { childList: true, subtree: true });

  var lastHref = location.href;
  timers.push(setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      schedule();
    }
  }, 500));
  timers.push(setInterval(function () {
    if (document.visibilityState === "visible") notify({ type: "check" });
  }, config.refreshMs));
  window.addEventListener("focus", function () {
    notify({ type: "check" });
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") notify({ type: "check" });
  });
  notify({ type: "check" });
  schedule();
}
/* eslint-enable no-var */

const PAGE_CSS = `
/* T3 Code's own colors at the contrast set in its Appearance settings. */
.t3x-host, .t3x-pop, .t3x-section {
  --t3x-muted: var(--contrast-muted-foreground, var(--muted-foreground));
  --t3x-fg: var(--contrast-foreground, var(--foreground));
  --t3x-popover-fg: var(--contrast-popover-foreground, var(--popover-foreground));
  --t3x-accent-fg: var(--contrast-accent-foreground, var(--accent-foreground));
  --t3x-border: var(--contrast-border, var(--border));
  --t3x-input: var(--contrast-input, var(--input));
  --t3x-icon-muted: var(--contrast-icon-muted, var(--muted-foreground));
}
.t3x-host[data-t3-extras-usage] { flex: 1 1 auto; min-width: 0; display: flex; list-style: none; margin: 0; padding: 0; }
[data-t3-extras-usage] > button.t3x-strip {
  flex: 1 1 auto; width: 100%; min-width: 0; overflow: hidden; display: flex; justify-content: center;
  align-items: center; height: 1.75rem; padding: 0 .375rem; margin: 0 .25rem; border: 0; border-radius: .375rem;
  background: transparent; color: inherit; font: inherit; cursor: default; direction: ltr;
}
.t3x-strip:hover, .t3x-strip[aria-expanded="true"] { background: color-mix(in srgb, currentColor 8%, transparent); }
.t3x-strip:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.t3x-strip-inner { display: inline-flex; align-items: center; gap: .25rem; white-space: nowrap; }
.t3x-chip {
  display: inline-flex; align-items: center; gap: .25rem; padding: 1px .375rem; border-radius: 999px;
  background: color-mix(in srgb, var(--t3x-accent) 22%, transparent); font-size: .6875rem; font-weight: 600;
  font-variant-numeric: tabular-nums; line-height: 1rem;
}
.t3x-dot { display: inline-block; width: .375rem; height: .375rem; border-radius: 50%; background: var(--t3x-accent, var(--t3x-muted)); flex: none; }
.t3x-acct-name .t3x-dot { margin-inline-end: .375rem; vertical-align: middle; }
.t3x-pace { width: .6875rem; height: .6875rem; flex: none; fill: none; stroke: var(--t3x-accent, var(--t3x-muted)); stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
.t3x-pop {
  position: fixed; z-index: 2147483000; width: 14.5rem; overflow: auto; box-sizing: border-box;
  padding: .625rem .75rem; border: 1px solid var(--t3x-border); border-radius: .625rem;
  background: var(--popover); color: var(--t3x-popover-fg); direction: ltr;
  box-shadow: 0 10px 30px rgb(0 0 0 / 0.28); font-size: .75rem;
}
.t3x-pop-head { margin-bottom: .375rem; }
.t3x-pop-title { font-size: .6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--t3x-muted); }
.t3x-acct { padding: .375rem 0; border-top: 1px solid var(--t3x-border); }
.t3x-acct:first-child { border-top: 0; }
.t3x-acct.t3x-old { opacity: .6; }
.t3x-acct-head { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; margin-bottom: 1px; }
.t3x-acct-name { min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3x-window-line { display: grid; grid-template-columns: 1fr 2.5rem 2rem .6875rem; gap: .375rem; align-items: center; margin-top: .1875rem; }
.t3x-window-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--t3x-muted); }
.t3x-acct .t3x-pct { text-align: end; font-weight: 600; font-variant-numeric: tabular-nums; }
.t3x-pace-cell { display: flex; align-items: center; justify-content: center; }
.t3x-reset { flex: none; font-size: .6875rem; color: var(--t3x-muted); }
.t3x-bar { height: .25rem; border-radius: .125rem; overflow: hidden; background: color-mix(in srgb, currentColor 12%, transparent); }
.t3x-bar i { display: block; height: 100%; border-radius: .125rem; background: var(--t3x-accent); }
.t3x-pop-foot {
  position: sticky; bottom: -.625rem; display: flex; align-items: center; justify-content: space-between; gap: .5rem;
  margin: .375rem -.75rem -.625rem; padding: .5rem .75rem; border-top: 1px solid var(--t3x-border); background: var(--popover);
}
.t3x-pop-foot[hidden] { display: none; }
.t3x-pop-version { min-width: 0; display: flex; align-items: center; gap: .375rem; color: var(--t3x-muted); white-space: nowrap; }
.t3x-mark { flex: none; display: inline-flex; }
.t3x-icon { width: .875rem; height: .875rem; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
/* The sizes, colors, and shapes of T3 Code's own settings controls. The sizes
   are in rem, so they follow its interface text size. */
.t3x-btn, .t3x-pop-btn {
  flex: none; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; white-space: nowrap;
  border: 1px solid var(--t3x-input); border-radius: var(--control-radius, .5rem); background: var(--popover); color: var(--t3x-fg);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.05); font: inherit; font-weight: 500; cursor: pointer; transition: scale .15s;
}
.t3x-btn { min-width: 10rem; height: 1.75rem; padding: 0 calc(.625rem - 1px); font-size: .875rem; line-height: 1.25rem; }
.t3x-pop-btn { width: 1.5rem; height: 1.5rem; padding: 0; }
:is(.t3x-btn, .t3x-pop-btn):hover:not([aria-disabled="true"]) { background: color-mix(in srgb, var(--accent) 50%, var(--popover)); }
:is(.t3x-btn, .t3x-pop-btn):active:not([aria-disabled="true"]) { scale: .97; }
:is(.t3x-btn, .t3x-pop-btn)[aria-disabled="true"] { opacity: .64; cursor: not-allowed; }
.dark :is(.t3x-btn, .t3x-pop-btn, .t3x-trigger) { background: color-mix(in srgb, var(--t3x-input) 32%, transparent); }
.dark :is(.t3x-btn, .t3x-pop-btn):hover:not([aria-disabled="true"]) { background: color-mix(in srgb, var(--t3x-input) 64%, transparent); }
.t3x-pop-foot .t3x-pop-btn[data-icon="download"] { border-color: var(--primary); background: var(--primary); color: var(--primary-foreground); }
.t3x-pop-foot .t3x-pop-btn[data-icon="download"]:hover:not([aria-disabled="true"]) { background: color-mix(in srgb, var(--primary) 90%, transparent); }
@media (prefers-reduced-motion: no-preference) {
  .t3x-pop-btn[aria-disabled="true"] .t3x-icon { animation: t3x-spin 1s linear infinite; }
}
@keyframes t3x-spin { to { rotate: 360deg; } }
.t3x-section { display: grid; gap: .625rem; direction: ltr; }
/* In the right-to-left layout the section and the usage list read right to
   left like the rest of the app. */
:root[data-t3-rtl-app="on"] :is(.t3x-section, .t3x-pop) { direction: rtl; }
.t3x-head { padding: 0 .75rem; }
.t3x-title { margin: 0; font-size: 1rem; line-height: 1.75rem; font-weight: 600; }
.t3x-sub, .t3x-row-desc, .t3x-notes, .t3x-notes-title, .t3x-error { font-size: .75rem; line-height: 1.125rem; }
.t3x-sub, .t3x-row-desc, .t3x-notes { color: var(--t3x-muted); }
.t3x-sub { margin: 0; }
.t3x-card {
  container-type: inline-size; border: 1px solid color-mix(in srgb, var(--t3x-border) 60%, transparent); border-radius: calc(var(--radius, 8px) + 4px);
  background: color-mix(in srgb, var(--card) 40%, transparent); color: var(--t3x-fg); box-shadow: 0 1px 2px rgb(0 0 0 / 0.05);
}
.t3x-row { display: flex; flex-direction: column; align-items: flex-start; gap: .75rem; padding: .75rem; }
.t3x-card > :not(:first-child) { border-top: 1px solid color-mix(in srgb, var(--t3x-border) 50%, transparent); }
@container (min-width: 32rem) {
  .t3x-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 2rem; }
}
@media (min-width: 640px) {
  .t3x-head { padding: 0 1rem; }
  .t3x-row { padding: .75rem 1rem; }
}
.t3x-row-title { font-size: .875rem; line-height: 1.25rem; font-weight: 500; }
.t3x-row-desc { max-width: 42rem; margin-top: .25rem; text-wrap: pretty; }
.t3x-notes-title { margin-top: .5rem; font-weight: 500; }
.t3x-notes { margin: 0; padding-inline-start: 1rem; list-style: disc; }
.t3x-switch {
  flex: none; display: inline-flex; align-items: center; width: calc(2rem - 2px); height: calc(1rem + 2px); padding: 2px; border: 0; border-radius: 999px;
  background: var(--t3x-input); cursor: pointer; transition: background-color .2s, box-shadow .2s;
}
.t3x-switch[aria-checked="true"] { background: var(--primary); }
.t3x-knob { width: calc(1rem - 2px); height: calc(1rem - 2px); border-radius: 50%; background: var(--background); box-shadow: 0 1px 3px rgb(0 0 0 / 0.05); transition: translate .15s; }
.dark .t3x-switch[aria-checked="false"] .t3x-knob { background: var(--t3x-muted); }
.t3x-switch[aria-checked="true"] .t3x-knob { translate: calc(1rem - 4px); }
.t3x-switch[aria-checked="true"]:dir(rtl) .t3x-knob { translate: calc(4px - 1rem); }
.t3x-seg { display: inline-flex; flex: none; gap: .125rem; padding: .125rem; border-radius: var(--radius, .5rem); background: color-mix(in srgb, var(--t3x-input) 40%, transparent); }
.t3x-seg-btn {
  height: 1.5rem; padding: 0 .625rem; border: 0; border-radius: calc(var(--radius, 8px) - 2px); background: transparent;
  color: var(--t3x-muted); font: inherit; font-size: .75rem; line-height: 1rem; font-weight: 500;
  font-variant-numeric: tabular-nums; cursor: pointer; transition: color .15s, background-color .15s;
}
.t3x-seg-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--background) 55%, transparent); color: var(--t3x-fg); }
.t3x-seg-btn[aria-checked="true"], .t3x-seg-btn[aria-checked="true"]:hover { background: var(--background); color: var(--t3x-fg); box-shadow: 0 1px 2px rgb(0 0 0 / 0.1); }
.dark .t3x-seg-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--t3x-input) 32%, transparent); }
.dark .t3x-seg-btn[aria-checked="true"] { background: color-mix(in srgb, var(--t3x-input) 72%, transparent); }
.t3x-select { position: relative; flex: none; }
.t3x-trigger {
  display: inline-flex; align-items: center; gap: .375rem; min-width: 10rem; height: 1.75rem; padding: 0 calc(.625rem - 1px); justify-content: space-between;
  box-sizing: border-box; border: 1px solid var(--t3x-input); border-radius: var(--radius, .5rem); background: var(--background);
  color: var(--t3x-fg); box-shadow: 0 1px 2px rgb(0 0 0 / 0.05); font: inherit; font-size: .875rem; line-height: 1.25rem; cursor: pointer;
}
:is(.t3x-switch, .t3x-seg-btn, .t3x-trigger):disabled { opacity: .64; cursor: not-allowed; }
.t3x-caret { flex: none; width: .875rem; height: .875rem; margin-inline-end: -.25rem; color: var(--t3x-icon-muted); opacity: .7; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
:is(.t3x-btn, .t3x-pop-btn, .t3x-switch, .t3x-seg-btn, .t3x-trigger, .t3x-option):focus-visible {
  outline: none; box-shadow: inset 0 0 0 1px var(--background), inset 0 0 0 3px var(--ring);
}
.t3x-list {
  position: absolute; inset-inline-end: 0; top: calc(100% + 4px); z-index: 50; min-width: 15rem; max-height: 20rem; overflow: auto;
  padding: .25rem; border: 1px solid var(--t3x-border); border-radius: var(--radius, .5rem); background: var(--popover);
  color: var(--t3x-popover-fg); box-shadow: 0 16px 40px -18px rgb(0 0 0 / 0.55);
}
.t3x-list.t3x-up { top: auto; bottom: calc(100% + 4px); }
@container (max-width: 31.99rem) { .t3x-list { inset-inline: 0 auto; } }
.t3x-group-title { padding: .375rem .5rem; font-size: .75rem; line-height: 1rem; font-weight: 500; color: var(--t3x-muted); }
.t3x-option { display: flex; align-items: center; gap: .5rem; min-height: 1.75rem; box-sizing: border-box; padding: .25rem .5rem; border-radius: calc(var(--radius, 8px) - 4px); font-size: .875rem; line-height: 1.25rem; cursor: pointer; }
.t3x-option:hover, .t3x-option:focus { background: var(--accent); color: var(--t3x-accent-fg); outline: none; }
.t3x-check { width: 1rem; height: 1rem; flex: none; box-sizing: border-box; border: 1px solid color-mix(in srgb, currentColor 40%, transparent); border-radius: .25rem; display: grid; place-items: center; }
.t3x-check svg { width: .75rem; height: .75rem; fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; visibility: hidden; }
.t3x-option[aria-selected="true"] .t3x-check { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.t3x-option[aria-selected="true"] .t3x-check svg { visibility: visible; }
.t3x-option-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3x-option-note { font-size: .75rem; color: var(--t3x-muted); }
.t3x-error { margin: 0; padding: .75rem 1rem; color: var(--destructive); }
`;

function buildExtrasPageSource({ binding, receiver, protocol = "t3code:", refreshMs = 60 * 1000, dimAfterMs = 30 * 60 * 1000 }) {
  const config = { binding, receiver, protocol, refreshMs, dimAfterMs, css: PAGE_CSS };
  return `(${pageMain.toString()})(${JSON.stringify(config)});`;
}

module.exports = { buildExtrasPageSource };

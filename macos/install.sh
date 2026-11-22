#!/bin/bash
# T3 Code RTL Fix - macOS installer
# Usage:  bash macos/install.sh ["/Applications/T3 Code (Alpha).app"]
#    or:  curl -fsSL https://raw.githubusercontent.com/ShlomiPorush/t3code-rtl-fix/main/macos/install.sh | bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"

# Run through "curl ... | bash", this script has no repository around it.
# Download the repository, run the installer it contains, and remove the
# download. T3_RTL_FIX_SOURCE can point to a local ZIP instead.
if [ ! -f "$SCRIPT_DIR/../src/injection.js" ]; then
  PACKAGE="${T3_RTL_FIX_SOURCE:-https://github.com/ShlomiPorush/t3code-rtl-fix/archive/refs/heads/main.zip}"
  WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/t3-rtl-install.XXXXXX")"
  trap 'rm -rf "$WORK_DIR"' EXIT
  case "$PACKAGE" in
    https://*)
      echo "Downloading T3 Code RTL Fix..."
      curl -fsSL "$PACKAGE" -o "$WORK_DIR/package.zip"
      ;;
    *)
      cp "$PACKAGE" "$WORK_DIR/package.zip"
      ;;
  esac
  unzip -q "$WORK_DIR/package.zip" -d "$WORK_DIR/package"
  INSTALLER="$(find "$WORK_DIR/package" -path '*/macos/install.sh' -type f | head -n 1)"
  if [ -z "$INSTALLER" ] || [ ! -f "$(dirname "$INSTALLER")/../src/injection.js" ]; then
    echo "The downloaded package does not contain the macOS installer and its src folder."
    exit 1
  fi
  bash "$INSTALLER" "$@"
  exit 0
fi

SRC="$(cd "$SCRIPT_DIR/.." && pwd)/src"
INSTALL_DIR="$HOME/Library/Application Support/T3RTLFix"
LAUNCHER_APP="$HOME/Applications/T3 Code RTL.app"

# The fix itself, which goes into a folder of its own for each install, so a
# running T3 Code can switch to it, and the launcher host, which keeps T3
# Code's debugging pipe and loads the fix.
CORE_FILES="rtl.css injection.js launcher-core.js annotation-direction.js repo-status.js cdp-dispatch.js extras.js extras-page.js extras-settings.js usage-limits.js app-layout.js css-mirror.js chat-width.js reply-start.js working-shelf.js"
HOST_FILE="t3-rtl-launcher.js"
for f in $CORE_FILES $HOST_FILE; do
  [ -f "$SRC/$f" ] || { echo "Missing file: src/$f"; exit 1; }
done

# --- Find T3 Code.app ---------------------------------------------------------
APP="${1:-}"
if [ -z "$APP" ]; then
  for candidate in /Applications/T3*.app "$HOME/Applications/"T3*.app /Applications/t3*.app; do
    [ -d "$candidate" ] || continue
    case "$candidate" in *"T3 Code RTL.app") continue ;; esac
    APP="$candidate"; break
  done
fi
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  echo "T3 Code was not found in /Applications."
  echo "Run again with the app path, e.g.:  bash macos/install.sh \"/Applications/T3 Code (Alpha).app\""
  exit 1
fi

EXE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
APP_EXE="$APP/Contents/MacOS/$EXE_NAME"
[ -x "$APP_EXE" ] || { echo "Executable not found: $APP_EXE"; exit 1; }
echo "Found T3 Code: $APP"

# --- Find a Node.js (>=18) to run the launcher; fall back to T3's own Electron --
NODE_BIN=""
for n in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -n "$n" ] && [ -x "$n" ] || continue
  if "$n" -e 'process.exit(parseInt(process.versions.node,10)>=18?0:1)' 2>/dev/null; then
    NODE_BIN="$n"; break
  fi
done
if [ -n "$NODE_BIN" ]; then echo "Using Node.js: $NODE_BIN"; else echo "Node.js not found, will use T3 Code's built-in runtime"; fi

run_node() {
  if [ -n "$NODE_BIN" ]; then "$NODE_BIN" "$@"; else ELECTRON_RUN_AS_NODE=1 "$APP_EXE" "$@"; fi
}

# --- Copy files ---------------------------------------------------------------
mkdir -p "$INSTALL_DIR"

# One install at a time, so the fix that current.txt names, the launcher
# host, and the launcher app always come from the same install. macOS's
# shlock holds the lock for this script's process and takes over, in one
# step, a lock whose process has ended. The lock goes when this script ends.
LOCK_FILE="$INSTALL_DIR/install.lock"
if ! /usr/bin/shlock -f "$LOCK_FILE" -p $$; then
  echo "Another install of T3 Code RTL Fix is running. Run this one again when it ends."
  exit 1
fi
trap 'rm -f "$LOCK_FILE"' EXIT

# Whether the T3 Code that is open now runs this launcher host, which then
# takes the update on its own: the host's record names a live process that
# started when the record says, runs the host being installed, and offers
# what the new fix needs.
HOST_STATE="$(run_node -e '
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { execFileSync } = require("child_process");
const [dir, src] = process.argv.slice(-2);
try {
  const record = JSON.parse(fs.readFileSync(path.join(dir, "running-host.json"), "utf8"));
  process.kill(record.pid, 0);
  const started = Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(record.pid)], { encoding: "utf8" }).trim());
  if (!(Math.abs(started - record.startedAt) <= 10000)) throw new Error("another process");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(src, "t3-rtl-launcher.js"))).digest("hex");
  const api = (/const REQUIRES_HOST_API = (\d+);/.exec(fs.readFileSync(path.join(src, "launcher-core.js"), "utf8")) || [])[1];
  console.log(hash === record.hash && api === String(record.hostApi) ? "live" : "restart");
} catch {
  console.log("none");
}' "$INSTALL_DIR" "$SRC" 2>/dev/null || echo none)"

# The fix, in a new folder. A running launcher looks at current.txt only,
# and only once it names this folder, which is complete by then.
VERSION_ID="$(date -u +%Y%m%d-%H%M%S)-$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 6)"
VERSION_DIR="$INSTALL_DIR/versions/$VERSION_ID"
mkdir -p "$VERSION_DIR"
for f in $CORE_FILES; do
  cp "$SRC/$f" "$VERSION_DIR/"
done
printf '%s' "$VERSION_ID" > "$INSTALL_DIR/current.txt.$$.tmp"
mv -f "$INSTALL_DIR/current.txt.$$.tmp" "$INSTALL_DIR/current.txt"

printf '%s' "$APP_EXE" > "$INSTALL_DIR/app-path.txt"
printf '%s' "$NODE_BIN" > "$INSTALL_DIR/node-path.txt"
cp "$SCRIPT_DIR/uninstall.sh" "$INSTALL_DIR/uninstall.sh"

cat > "$INSTALL_DIR/launch.sh" <<'LAUNCH'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_EXE="$(cat "$DIR/app-path.txt")"
NODE_BIN="$(cat "$DIR/node-path.txt" 2>/dev/null)"
if [ ! -x "$APP_EXE" ]; then
  osascript -e 'display alert "T3 Code RTL Fix" message "T3 Code was not found. Run the install command again."'
  exit 1
fi
if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
  exec "$NODE_BIN" "$DIR/t3-rtl-launcher.js"
else
  ELECTRON_RUN_AS_NODE=1 exec "$APP_EXE" "$DIR/t3-rtl-launcher.js"
fi
LAUNCH
chmod +x "$INSTALL_DIR/launch.sh"

# The launcher host goes last: until here, the launcher that was installed
# before still opens T3 Code with the files it knows.
cp "$SRC/$HOST_FILE" "$INSTALL_DIR/$HOST_FILE.$$.tmp"
mv -f "$INSTALL_DIR/$HOST_FILE.$$.tmp" "$INSTALL_DIR/$HOST_FILE"

# Earlier versions that neither run nor are the fallback, after a week.
KEEP_CURRENT="$(cat "$INSTALL_DIR/current.txt" 2>/dev/null || true)"
KEEP_LAST_GOOD="$(cat "$INSTALL_DIR/last-good.txt" 2>/dev/null || true)"
find "$INSTALL_DIR/versions" -mindepth 1 -maxdepth 1 -type d -mtime +7 2>/dev/null | while IFS= read -r old; do
  name="$(basename "$old")"
  # Only folders an installer made, by the shape of their name.
  printf '%s' "$name" | grep -Eq '^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$' || continue
  [ "$name" = "$VERSION_ID" ] || [ "$name" = "$KEEP_CURRENT" ] || [ "$name" = "$KEEP_LAST_GOOD" ] || rm -rf "$old"
done

# --- Build the "T3 Code RTL" app ---------------------------------------------
mkdir -p "$HOME/Applications"
rm -rf "$LAUNCHER_APP"
osacompile -o "$LAUNCHER_APP" \
  -e "do shell script \"/bin/bash \" & quoted form of \"$INSTALL_DIR/launch.sh\" & \" > /dev/null 2>&1 &\""

# --- Use T3 Code's exact icon --------------------------------------------------
# osacompile gives the wrapper a default script icon (applet.icns and, on newer
# macOS, an Assets.car that takes priority over it). Replace both with the
# exact icon assets shipped inside T3 Code.app.
PLIST_BUDDY=/usr/libexec/PlistBuddy
SRC_PLIST="$APP/Contents/Info.plist"
DST_PLIST="$LAUNCHER_APP/Contents/Info.plist"
SRC_RES="$APP/Contents/Resources"
DST_RES="$LAUNCHER_APP/Contents/Resources"

ICON_FILE="$("$PLIST_BUDDY" -c 'Print :CFBundleIconFile' "$SRC_PLIST" 2>/dev/null || true)"
ICON_NAME="$("$PLIST_BUDDY" -c 'Print :CFBundleIconName' "$SRC_PLIST" 2>/dev/null || true)"
SRC_ICNS=""
if [ -n "$ICON_FILE" ]; then
  case "$ICON_FILE" in *.icns) ;; *) ICON_FILE="$ICON_FILE.icns" ;; esac
  [ -f "$SRC_RES/$ICON_FILE" ] && SRC_ICNS="$SRC_RES/$ICON_FILE"
fi
if [ -z "$SRC_ICNS" ]; then
  for f in "$SRC_RES"/*.icns; do [ -f "$f" ] && { SRC_ICNS="$f"; break; }; done
fi
SRC_CAR=""
if [ -n "$ICON_NAME" ] && [ -f "$SRC_RES/Assets.car" ]; then SRC_CAR="$SRC_RES/Assets.car"; fi

if [ -n "$SRC_ICNS" ] || [ -n "$SRC_CAR" ]; then
  rm -f "$DST_RES/applet.icns" "$DST_RES/Assets.car"
  "$PLIST_BUDDY" -c 'Delete :CFBundleIconFile' "$DST_PLIST" 2>/dev/null || true
  "$PLIST_BUDDY" -c 'Delete :CFBundleIconName' "$DST_PLIST" 2>/dev/null || true
  if [ -n "$SRC_ICNS" ]; then
    cp "$SRC_ICNS" "$DST_RES/AppIcon.icns"
    "$PLIST_BUDDY" -c 'Add :CFBundleIconFile string AppIcon.icns' "$DST_PLIST"
  fi
  if [ -n "$SRC_CAR" ]; then
    cp "$SRC_CAR" "$DST_RES/Assets.car"
    "$PLIST_BUDDY" -c "Add :CFBundleIconName string $ICON_NAME" "$DST_PLIST"
  fi
  if [ -n "$SRC_ICNS" ] && cmp -s "$SRC_ICNS" "$DST_RES/AppIcon.icns"; then
    echo "Icon: copied from $(basename "$SRC_ICNS") (identical)"
  fi
  [ -n "$SRC_CAR" ] && echo "Icon: copied Assets.car ($ICON_NAME)"
else
  echo "Warning: no icon found in T3 Code.app, keeping the default icon"
fi
"$PLIST_BUDDY" -c 'Set :CFBundleName T3 Code RTL' "$DST_PLIST" 2>/dev/null || true

# Re-sign ad hoc because the bundle resources changed, then refresh the icon cache
codesign --force --deep --sign - "$LAUNCHER_APP" >/dev/null 2>&1 || true
touch "$LAUNCHER_APP"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$LAUNCHER_APP" >/dev/null 2>&1 || true

echo ""
echo "Done."
case "$HOST_STATE" in
  live)
    echo "The open T3 Code picks the update up in a few seconds: its windows reload, and running sessions keep running."
    ;;
  restart)
    echo "This update changes the launcher itself."
    echo "1. Quit T3 Code completely (Cmd+Q)."
    echo "2. Open \"T3 Code RTL\" from ~/Applications (or Spotlight: Cmd+Space -> T3 Code RTL)."
    ;;
  *)
    echo "1. Quit T3 Code completely (Cmd+Q)."
    echo "2. Open \"T3 Code RTL\" from ~/Applications (or Spotlight: Cmd+Space -> T3 Code RTL)."
    ;;
esac
echo "Your own CSS goes here, and updates never change it: $INSTALL_DIR/custom.css"
if [ -f "$INSTALL_DIR/rtl.css" ]; then
  echo "Earlier versions used $INSTALL_DIR/rtl.css. It stays there; copy any rules of your own from it into custom.css."
fi
echo "Log file: $INSTALL_DIR/launcher.log"
open -R "$LAUNCHER_APP" 2>/dev/null || true

#!/bin/bash
# T3 Code RTL Fix - macOS installer (port of install.ps1)
# Usage:  bash install-mac.sh ["/Applications/T3 Code (Alpha).app"]
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/src"
INSTALL_DIR="$HOME/Library/Application Support/T3RTLFix"
LAUNCHER_APP="$HOME/Applications/T3 Code RTL.app"

for f in rtl.css injection.js t3-rtl-launcher.js; do
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
  echo "Run again with the app path, e.g.:  bash install-mac.sh \"/Applications/T3 Code (Alpha).app\""
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

# --- Copy files ---------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
cp "$SRC/rtl.css" "$SRC/injection.js" "$SRC/t3-rtl-launcher.js" "$INSTALL_DIR/"
printf '%s' "$APP_EXE" > "$INSTALL_DIR/app-path.txt"
printf '%s' "$NODE_BIN" > "$INSTALL_DIR/node-path.txt"
cp "$SCRIPT_DIR/uninstall-mac.sh" "$INSTALL_DIR/" 2>/dev/null || true

cat > "$INSTALL_DIR/launch.sh" <<'LAUNCH'
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
APP_EXE="$(cat "$DIR/app-path.txt")"
NODE_BIN="$(cat "$DIR/node-path.txt" 2>/dev/null)"
if [ ! -x "$APP_EXE" ]; then
  osascript -e 'display alert "T3 Code RTL Fix" message "T3 Code was not found. Run install-mac.sh again."'
  exit 1
fi
if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
  exec "$NODE_BIN" "$DIR/t3-rtl-launcher.js"
else
  ELECTRON_RUN_AS_NODE=1 exec "$APP_EXE" "$DIR/t3-rtl-launcher.js"
fi
LAUNCH
chmod +x "$INSTALL_DIR/launch.sh"

# --- Build the "T3 Code RTL" app ---------------------------------------------
mkdir -p "$HOME/Applications"
rm -rf "$LAUNCHER_APP"
osacompile -o "$LAUNCHER_APP" \
  -e "do shell script \"/bin/bash \" & quoted form of \"$INSTALL_DIR/launch.sh\" & \" > /dev/null 2>&1 &\""

# Reuse T3 Code's icon
ICON="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$APP/Contents/Info.plist" 2>/dev/null || true)"
if [ -n "$ICON" ]; then
  case "$ICON" in *.icns) ;; *) ICON="$ICON.icns" ;; esac
  if [ -f "$APP/Contents/Resources/$ICON" ]; then
    cp "$APP/Contents/Resources/$ICON" "$LAUNCHER_APP/Contents/Resources/applet.icns"
    touch "$LAUNCHER_APP"
  fi
fi

echo ""
echo "Done!"
echo "1. Quit T3 Code completely (Cmd+Q)."
echo "2. Open \"T3 Code RTL\" from ~/Applications (or Spotlight: Cmd+Space -> T3 Code RTL)."
echo "Edit the CSS here: $INSTALL_DIR/rtl.css"
echo "Log file: $INSTALL_DIR/launcher.log"
open -R "$LAUNCHER_APP" 2>/dev/null || true

#!/bin/bash
# Installs the fix on macOS from a release package with the one-line command,
# then updates it the way Extras does. T3 Code, the home folder, and the
# download are stand-ins.
set -eu

REPOSITORY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# TMPDIR ends with a slash on macOS, and cd drops the double one.
ROOT="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/t3-rtl-macos-test.XXXXXX")" && pwd)"
trap 'rm -rf "$ROOT"' EXIT
fail() { echo "FAILED: $1"; exit 1; }

export HOME="$ROOT/home"
APP="$ROOT/apps/T3 Code (Test).app"
mkdir -p "$HOME" "$APP/Contents/MacOS" "$APP/Contents/Resources" "$ROOT/bin"
printf '#!/bin/bash\n' > "$APP/Contents/MacOS/T3 Code (Test)"
chmod +x "$APP/Contents/MacOS/T3 Code (Test)"
/usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string T3 Code (Test)' "$APP/Contents/Info.plist" > /dev/null

git -C "$REPOSITORY" archive --format=zip --prefix=t3code-rtl-fix/ --output="$ROOT/package.zip" HEAD
cat > "$ROOT/bin/curl" <<CURL
#!/bin/bash
echo "\$*" > "$ROOT/curl-arguments"
while [ "\$1" != "-o" ]; do shift; done
cp "$ROOT/package.zip" "\$2"
CURL
chmod +x "$ROOT/bin/curl"
export PATH="$ROOT/bin:$PATH"

INSTALL_DIR="$HOME/Library/Application Support/T3RTLFix"
VERSION="$(node -p "require('$REPOSITORY/package.json').version")"
recorded() { cut -d ' ' -f 1 "$INSTALL_DIR/version.txt"; }

# From macos/, where a script without a file of its own could take the
# repository around the folder for its package.
(cd "$REPOSITORY/macos" && bash -s "$APP" < install.sh)
grep -q 'releases/latest/download/t3code-rtl-fix.zip' "$ROOT/curl-arguments" || fail "the one-line install did not download the latest release"
[ "$(recorded)" = "$VERSION" ] || fail "the installer did not record its version"
for f in "$REPOSITORY"/src/* "$REPOSITORY"/macos/*; do
  cmp -s "$f" "$INSTALL_DIR/$(basename "$f")" || fail "$(basename "$f") was not installed"
done
[ -d "$HOME/Applications/T3 Code RTL.app" ] || fail "the launcher app was not built"

mkdir "$ROOT/next"
unzip -q "$ROOT/package.zip" -d "$ROOT/next"
sed -i '' "s/\"version\": \"$VERSION\"/\"version\": \"99.0.0\"/" "$ROOT/next/t3code-rtl-fix/package.json"
rm "$ROOT/package.zip"
(cd "$ROOT/next" && zip -qr "$ROOT/package.zip" t3code-rtl-fix)

# A build of the launcher app that fails keeps the app and the version.
printf '#!/bin/bash\nexit 1\n' > "$ROOT/bin/osacompile"
chmod +x "$ROOT/bin/osacompile"
run_update() { node -e 'require(process.argv[1]).runInstaller({ directory: process.argv[2], version: "99.0.0" })' "$INSTALL_DIR/updates.js" "$INSTALL_DIR"; }
# The update puts the folder of Node.js first, so the stand-in must be there.
NODE_FOLDER="$(dirname "$(node -p process.execPath)")"
[ ! -e "$NODE_FOLDER/curl" ] && [ ! -e "$NODE_FOLDER/osacompile" ] || fail "the folder of Node.js hides the stand-ins"
run_update
[ "$(recorded)" = "$VERSION" ] || fail "a failed update recorded its version"
[ -d "$HOME/Applications/T3 Code RTL.app" ] || fail "a failed update removed the launcher app"

rm "$ROOT/bin/osacompile"
run_update
cat "$INSTALL_DIR/launcher.log"
grep -q 'releases/download/v99.0.0/t3code-rtl-fix.zip' "$ROOT/curl-arguments" || fail "the update did not download its release"
[ "$(recorded)" = "99.0.0" ] || fail "the update did not record its version"
[ "$(cat "$INSTALL_DIR/app-path.txt")" = "$APP/Contents/MacOS/T3 Code (Test)" ] || fail "the update changed the T3 Code path"
[ "$(cat "$INSTALL_DIR/node-path.txt")" = "$NODE_FOLDER/node" ] || fail "the update did not keep the Node.js of the launcher"
[ -d "$HOME/Applications/T3 Code RTL.app" ] || fail "the update removed the launcher app"
echo "macOS one-line installation and update passed."

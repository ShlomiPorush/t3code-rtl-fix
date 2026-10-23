"use strict";

const fs = require("node:fs");

// The size and modification time of the T3 Code executable. The installer of
// an update keeps the build time of each file, so a new version is detected
// by a different value, never by a later one. A file that cannot be read,
// such as one removed in the middle of an update, has no signature.
function readExecutableSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

// Resolves true as soon as the signature differs from the one taken at launch,
// and false when it stays the same for the whole window. This is a hint only:
// the Windows helper confirms that T3 Code was really reopened by an update.
function watchForReplacement({
  readSignature,
  initialSignature,
  intervalMs,
  timeoutMs,
  setTimer = setTimeout,
  now = Date.now,
}) {
  const deadline = now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      if (readSignature() !== initialSignature) {
        resolve(true);
        return;
      }
      if (now() >= deadline) {
        resolve(false);
        return;
      }
      setTimer(check, intervalMs);
    };
    check();
  });
}

module.exports = { readExecutableSignature, watchForReplacement };

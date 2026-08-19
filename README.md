# T3 Code RTL Fix

Automatically aligns each T3 Code user and assistant message from its own text
while keeping code, commands, file paths, and table structure left to right.

The fix is applied every time the T3 Code desktop app starts. It removes the
need to open DevTools and paste CSS manually.

## What it changes

- Hebrew and Arabic messages use right-to-left direction and right alignment.
- English messages remain left to right and left aligned.
- Each paragraph and other prose block follows its own first meaningful character.
- Code, commands, file paths, and table structure remain left to right.
- Lists, task lists, quotes, footnotes, alerts, and table cells follow the
  direction of their text.
- T3 Code itself is not patched or repackaged.
- Existing Desktop and Start menu shortcuts are backed up before modification.

## Requirements

- Windows
- The T3 Code desktop app

## Install

Clone or download this repository, then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Fully quit T3 Code after installation. Open it again from the Desktop shortcut
or the Start menu shortcut updated by the installer.

The installed files are stored in:

```text
%LOCALAPPDATA%\T3RTLFix
```

If T3 Code is installed in a non-default location, pass the executable path:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -T3CodePath "D:\Apps\T3 Code (Alpha).exe"
```

## Customize the CSS

Edit the installed `rtl.css` file:

```text
%LOCALAPPDATA%\T3RTLFix\rtl.css
```

Fully quit and reopen T3 Code after making a change.

## Uninstall

Run the installed uninstaller:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "$env:LOCALAPPDATA\T3RTLFix\uninstall.ps1"
```

The uninstaller restores the original shortcuts. You can then delete the
`%LOCALAPPDATA%\T3RTLFix` directory.

## How it works

The shortcut uses the Node.js runtime already bundled inside T3 Code's Electron
executable to start a small local launcher. No separate Node.js installation is
required. The launcher then opens T3 Code normally with Chromium's
`--remote-debugging-pipe` option and injects the fix into the T3 Code page. The
fix applies `dir="auto"` to existing and newly rendered messages, injects
`rtl.css`, and registers both parts for future page reloads.

The connection uses inherited process pipes. It does not open a local TCP
debugging port and does not send data over the network.

## Limitations

- T3 Code must be opened from a shortcut updated by the installer.
- A T3 Code update may recreate its shortcuts. Run `install.ps1` again if the
  fix stops loading after an update.
- T3 Code can change its internal HTML structure. The selectors in `rtl.css`
  may need an update when that happens.
- The first installation cannot inject into an instance that is already open.
  Fully quit and reopen the app once.

## Test

Contributors need Node.js 18 or newer. On Windows with Microsoft Edge installed:

```powershell
npm test
```

The smoke test verifies CSS injection through a Chromium debugging pipe. A
separate regression test performs a complete installation and removal under
Windows PowerShell 5.1. The unit tests also verify that no TCP debugging port is
enabled and that shipped user-facing text contains no Hebrew.

## License

[MIT](LICENSE)

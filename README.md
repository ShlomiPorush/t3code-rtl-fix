# T3 Code RTL Fix

Automatically displays T3 Code assistant messages from right to left while
keeping code blocks and inline code left to right.

The fix is applied every time the T3 Code desktop app starts. It removes the
need to open DevTools and paste CSS manually.

## What it changes

- Assistant message content uses right-to-left direction and right alignment.
- `pre` and `code` elements remain left to right and left aligned.
- T3 Code itself is not patched or repackaged.
- Existing Desktop and Start menu shortcuts are backed up before modification.

## Requirements

- Windows
- The T3 Code desktop app
- Node.js 18 or newer

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

The shortcut starts a small local Node.js launcher. The launcher opens T3 Code
with Chromium's `--remote-debugging-pipe` option and injects `rtl.css` into the
T3 Code page. It also registers the CSS for future page reloads.

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

On Windows with Microsoft Edge installed:

```powershell
npm test
```

The smoke test verifies CSS injection through a Chromium debugging pipe. The
unit tests also verify that no TCP debugging port is enabled and that shipped
user-facing text contains no Hebrew.

## License

[MIT](LICENSE)

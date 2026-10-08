# T3 Code RTL Fix

Automatically aligns each T3 Code user and assistant message from its own text
while keeping code, commands, and file paths left to right.

The fix is applied every time the T3 Code desktop app starts. It removes the
need to open DevTools and paste CSS manually.

## What it changes

- Hebrew and Arabic messages use right-to-left direction and right alignment.
- English messages remain left to right and left aligned.
- Hebrew and Arabic prose stays right to left even when it starts with English or a number.
- Each paragraph and other prose block resolves its direction independently.
- Images and other blocks without any letters follow the direction of the
  message around them.
- Code, commands, and file paths remain left to right.
- Tables follow their content direction, and expanded tables fit the available width.
- Lists, task lists, quotes, footnotes, alerts, and table cells follow the
  direction of their text.
- Pending question cards align their content and option shortcuts without
  changing English questions.
- Proposed plan cards align their title and Markdown content independently.
- Plan progress and composer task controls follow the direction of their steps.
- Pull request descriptions and comments follow the direction of each Markdown block.
- Rendered Markdown file previews follow the direction of each content block.
- Comments on quoted text and their citation chips follow the direction of the
  comment while it is typed.
- Queued messages follow the direction of their prompt, including their status
  and action buttons.
- Each paragraph typed in the composer follows the same rule as a sent
  message: Hebrew or Arabic anywhere in it makes it right to left, even after
  an English word or an attachment chip, and word selection with
  Ctrl+Shift+Arrow moves the same way as the text. A line that holds only a
  quote with a Hebrew or Arabic comment is right to left as well.
- The agent's work log follows the direction of its text. Asked questions and
  their answers follow the message rule, and row summaries follow their first
  letter so commands that start in English stay left to right.
- Thread titles in the sidebar and the open thread header follow the direction
  of their text, including while a thread is renamed.
- T3 Code itself is not patched or repackaged.

## Requirements

- Windows or macOS
- The T3 Code desktop app

## Windows

### Install or update

Run this in PowerShell:

```powershell
irm 'https://raw.githubusercontent.com/ShlomiPorush/t3code-rtl-fix/main/windows/install.ps1' | iex
```

The command downloads the current version of this repository, installs it, and
removes the downloaded copy. Run the same command again to update the fix, or
after a T3 Code update if the fix stops loading.

Fully quit T3 Code after installation. Open it again from the Desktop shortcut
or the Start menu shortcut updated by the installer. The installer backs up the
original shortcuts first.

If T3 Code is installed in a non-default location, pass the executable path:

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/ShlomiPorush/t3code-rtl-fix/main/windows/install.ps1'))) `
  -T3CodePath "D:\Apps\T3 Code (Alpha).exe"
```

To install from a local clone instead, run this from the repository folder:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\windows\install.ps1
```

### Customize the CSS

Edit the installed `rtl.css` file, then fully quit and reopen T3 Code:

```text
%LOCALAPPDATA%\T3RTLFix\rtl.css
```

### Uninstall

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "$env:LOCALAPPDATA\T3RTLFix\uninstall.ps1"
```

The uninstaller restores the original shortcuts. You can then delete the
`%LOCALAPPDATA%\T3RTLFix` directory.

## macOS

### Install or update

Run this in Terminal:

```bash
curl -fsSL 'https://raw.githubusercontent.com/ShlomiPorush/t3code-rtl-fix/main/macos/install.sh' | bash
```

The command downloads the current version of this repository, installs it, and
removes the downloaded copy. Run the same command again to update the fix.

The installer finds T3 Code in `/Applications` or `~/Applications`, copies the
fix to `~/Library/Application Support/T3RTLFix`, and creates a separate
**T3 Code RTL** app in `~/Applications` with the T3 Code icon. T3 Code itself
is not modified.

Fully quit T3 Code with Cmd+Q, then open **T3 Code RTL** from
`~/Applications` or Spotlight. Always open T3 Code through this app so the fix
loads. You can drag it to the Dock in place of the original.

If T3 Code is installed in a non-default location, pass the app path:

```bash
curl -fsSL 'https://raw.githubusercontent.com/ShlomiPorush/t3code-rtl-fix/main/macos/install.sh' |
  bash -s -- "/path/to/T3 Code (Alpha).app"
```

To install from a local clone instead, run this from the repository folder:

```bash
bash macos/install.sh
```

The launcher runs with Node.js 18 or newer when one is found on the system,
including Homebrew. Otherwise it uses the Node.js runtime bundled in T3 Code
through `ELECTRON_RUN_AS_NODE`, as on Windows.

### Customize the CSS

Edit the installed `rtl.css` file, then quit T3 Code with Cmd+Q and open
**T3 Code RTL** again:

```text
~/Library/Application Support/T3RTLFix/rtl.css
```

The launcher log is written to `launcher.log` in the same folder.

### Uninstall

```bash
bash ~/Library/Application\ Support/T3RTLFix/uninstall.sh
```

The uninstaller removes the **T3 Code RTL** app and the whole
`~/Library/Application Support/T3RTLFix` folder, including any changes made to
`rtl.css`. Open T3 Code normally afterwards.

## How it works

The installer starts T3 Code through a small local launcher instead of opening
it directly: a Desktop and Start menu shortcut on Windows, and the
**T3 Code RTL** app on macOS. The launcher runs on the Node.js runtime already
bundled inside T3 Code's Electron executable, or on a system Node.js on macOS,
so no separate installation is required. It opens T3 Code normally with
Chromium's `--remote-debugging-pipe` option and injects the fix into the T3 Code
page. The fix sets the direction of existing and newly rendered content, injects
`rtl.css`, and registers both parts for future page reloads.

The connection uses inherited process pipes. It does not open a local TCP
debugging port and does not send data over the network.

## Repository layout

```text
src/       The fix injected into T3 Code, shared by both platforms
windows/   Windows installer, uninstaller, and shortcut launcher
macos/     macOS installer and uninstaller
tests/     Unit, browser smoke, and Windows installer tests
```

## Limitations

- T3 Code must be opened from a shortcut updated by the installer on Windows,
  or from the T3 Code RTL app on macOS.
- A T3 Code update may recreate its Windows shortcuts. Run the install command
  again if the fix stops loading after an update.
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

## Credits

- macOS support was contributed by [@sagistiki](https://github.com/sagistiki)
  in [#27](https://github.com/ShlomiPorush/t3code-rtl-fix/pull/27).

## License

[MIT](LICENSE)

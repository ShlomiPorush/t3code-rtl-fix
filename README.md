# T3 Code RTL Fix

Turns the whole T3 Code app right to left, and aligns each user and assistant
message from its own text while keeping code, commands, and file paths left to
right.

The fix is applied every time the T3 Code desktop app starts. It removes the
need to open DevTools and paste CSS manually.

## What it changes

- Hebrew and Arabic messages use right-to-left direction and right alignment.
- English messages remain left to right and left aligned.
- Hebrew and Arabic prose stays right to left even when it starts with English or a number.
- T3 Code 0.1.2 and later set a direction of their own from the majority of
  the words in each block. The fix's rule replaces it, so a mostly English
  sentence with a Hebrew word stays right to left, in lists, tables, and
  alerts as well, and so does each block typed in the composer.
- Each paragraph and other prose block resolves its direction independently.
- Images and other blocks without any letters follow the direction of the
  message around them.
- Code, commands, and file paths remain left to right.
- Tables follow their content direction, and expanded tables fit the available width.
- A wide Hebrew or Arabic table opens on its first column at the right. Its
  edge fade and scrollbar follow the hidden part on the left.
- Lists, task lists, quotes, footnotes, alerts, and table cells follow the
  direction of their text. In a Hebrew or Arabic table every column aligns
  right, including English headers and values.
- Pending question cards align their content without changing English
  questions. In a Hebrew or Arabic option, the shortcut number sits next to
  the radio button, before the option text.
- Proposed plan cards align their title and Markdown content independently.
- Plan progress and composer task controls follow the direction of their steps.
- Pull request descriptions and comments follow the direction of each Markdown block.
- Rendered Markdown file previews follow the direction of each content block.
- Comments on quoted text and their citation chips follow the direction of the
  comment while it is typed. In the card that opens from a citation chip, the
  quote and the comment follow the direction of their text, and the quote
  border and the Go to source button move to the side where the text starts.
- Queued messages follow the direction of their prompt, including their status
  and action buttons. In the queue above the composer, each prompt follows the
  direction of its text. Since T3 Code 0.1.3, a queued prompt waits in the
  thread above the composer and follows the message rule, while the buttons
  below it keep their layout.
- Each paragraph typed in the composer follows the same rule as a sent
  message: Hebrew or Arabic anywhere in it makes it right to left, even after
  an English word or an attachment chip, and word selection with
  Ctrl+Shift+Arrow moves the same way as the text. A line that holds only a
  quote with a Hebrew or Arabic comment is right to left as well. Headings,
  list items, task list items, and quotes typed in the composer follow the
  same rule, and a list or quote moves its markers or border to the side where
  its first item starts.
- With prompt suggestions on, a predicted next prompt shown in the empty
  composer follows the direction of its text. A Hebrew or Arabic prediction
  sits on the right, and the Tab key hint after it keeps its order.
- While a reply to quoted text is drafted, the quote shown after "Replying to"
  above the composer follows the direction of its text, and so does every
  other notice description there and its Notice details popup. A Hebrew or
  Arabic quote reads from the right and is cut at its end. The notice's icon,
  title, and dismiss button keep their layout.
- The agent's work log follows the direction of its text. Asked questions and
  their answers follow the message rule, and row summaries follow their first
  letter so commands that start in English stay left to right. A row whose
  summary starts in Hebrew or Arabic, such as an asked question, is mirrored:
  its icon and summary sit on the right, the question comes before the
  answer, and the expanded question and answer align right. The agent's
  latest thought, shown while it works, follows its first letter too, and an
  expanded thought follows the message rule.
- When the agent asks for a secret, the name and the reason on its card follow
  the message rule, while the field, its buttons, and the note below them
  keep their layout. Once the secret is saved or declined, a row whose name
  is in Hebrew or Arabic is mirrored, with its icon on the right.
- Subagent and delegated task cards show their title and result summary in the
  direction of their text.
- Thread titles in the sidebar and the open thread header follow the direction
  of their text, including while a thread is renamed. So do the parent thread
  and project names shown above a subagent's thread.
- Tooltips follow their first letter, so a tooltip that shows a Hebrew thread
  title or queued prompt is right to left.
- The comment field of the element annotation window in the browser preview
  follows the direction of the comment while it is typed, and so do the comment
  and page title in the card that opens from an annotation chip.
- Messages no longer show through around the composer at the bottom of a
  thread, behind its context row, or in the gap below it.
- T3 Code itself is not patched or repackaged.

## Right-to-left layout

The whole app is mirrored, as in a right-to-left language:

- The sidebar is on the right, and the right panel and the panel buttons are
  on the left. The thread header, the composer, menus, dialogs, and settings
  are mirrored, with their buttons and icons on the other side. Arrows and
  chevrons point the other way, an open chevron still points down, and a
  closed project's chevron points left.
- On Windows, the window's own minimize, maximize, and close buttons stay
  in its top right corner, above the sidebar, and the sidebar's logo and
  buttons keep clear of them. The layout has not been checked on macOS.
- Messages keep the rule of each block: Hebrew and Arabic read right to left,
  and an English message stays left to right and left aligned.
- An empty composer starts on the right, with its placeholder. A paragraph
  typed in English turns left to right, as before.
- English text in the app itself, such as settings, button labels, work log
  rows, and placeholders, sits on the right and keeps its reading order, so
  punctuation stays at the end of the sentence.
- Code, terminals, diffs, the file tree, paths and branch names, keyboard
  keys, and the T3 Code logo stay left to right.
- Dragging the edge of the sidebar or a panel moves it the way the pointer
  moves.
- The thread details card is on the left, under its button, whether it is
  docked beside the conversation or opens as a floating card, and the
  conversation keeps room for it there. T3 Code still keeps the floating
  browser preview clear of the card as if the card were on the right, so the
  preview can cover a docked card.

T3 Code itself is not changed. The fix reads T3 Code's stylesheets and adds a
copy of each one in which every left or right side becomes the start or end
side, then turns the original off. Turning the layout off removes the copies
and turns the originals on again, so T3 Code's own layout comes back exactly.
A stylesheet that the fix cannot read or copy stays as it is.

To turn the layout off, use the **Right-to-left layout** switch in the Extras
section of T3 Code's Labs settings. The change applies at once in every open
window. See [Extras settings](#extras-settings).

## Repository status

The thread details card shows a section with the open issues, open pull
requests, and open security alerts of the open thread's GitHub repository. A
new thread shows the section of its project's repository before its first
message.
Security alerts add up Dependabot, code scanning, and secret scanning alerts.
Click a row to open that page on GitHub in your browser.

Below them, a **Branches** group counts the repository's branches. The default
branch is never counted.

Point at a row, or move to it with the keyboard, to see its details:

- **Issues** and **Pull requests**: the most recently updated, with author,
  age, and labels, or the draft and review state.
- **Security alerts**: the alerts of each source by severity, with the
  affected package, rule, or secret type. The secret itself is never read
  into the section.
- **Branches**: the branch names with the age of their newest commit. Local
  branches also show whether they are ahead of or behind their branch on
  GitHub, as of the last fetch.

Each list shows up to 100 items. Scroll the details to reach them all. When
GitHub has a page with the whole list, a list with more than five items ends
with a line that opens it, such as "View all 12 on GitHub", or "and 40 more"
past 100 items. Local branches have no such page.

Move the pointer into the details and click an item to open its page on
GitHub: an issue, a pull request, an alert, or a branch. A local branch opens
the branch it tracks on GitHub. With the keyboard, press the Down arrow on a
row to reach its links, the Up and Down arrows to move between them, Enter to
open one, and Escape to return to the row.

A pull request opens in the thread's panel in T3 Code, as a pull request link
in a message does, when T3 Code's **Open pull requests in T3 Code** setting is
on. Ctrl-click, Cmd-click, or a middle click opens it on GitHub instead. T3
Code has no public way to open a pull request from outside it, so the fix uses
T3 Code's own panel code. When that does not work, for example after a T3 Code
update, the pull request opens on GitHub.

Drag an item into the message box to quote it. The quote is its number and
title, or its name, followed by its address on GitHub when it has one, such as
`#7 Fix the table direction https://github.com/owner/repo/issues/7`. A pull
request becomes T3 Code's own pull request reference instead, the same one you
get when you drag a pull request from T3 Code's panel.

- **Remote**: branches on GitHub. Click to open the branches page on GitHub.
- **Local**: branches in the project folder.
- **Dead**: branches on GitHub whose pull request merged with the branch's
  current commit, and local branches whose branch on GitHub was deleted.
- **Stale**: branches that are not dead and have no commit in the last 30
  days, locally or on GitHub.

The section reads at most 100 branches from GitHub. With more, the Dead and
Stale counts end with `+`, and local branches are not marked as deleted.

A row appears only when its count is above zero. The section stays hidden when
every count is zero, when the project has no GitHub `origin` remote, or when
GitHub cannot be read.

- The counts come from the [GitHub CLI](https://cli.github.com/). Install it
  and sign in with `gh auth login`. The fix never reads or stores the token.
- The launcher finds the thread's folder in T3 Code's database, which it opens
  read only. When the thread's worktree is no longer a Git repository, it uses
  the project folder. A new thread is not in the database before its first
  message, so the page reads its project from T3 Code's drafts in the page's
  local storage, and the launcher finds that project's folder.
- The counts refresh when you open another thread or return to the window, if
  they are older than a minute, and every 5 minutes while T3 Code is visible.
- A count that GitHub does not allow for your account, such as Dependabot
  alerts without access, is left out.
- Code scanning and secret scanning show at most `100+`.
- On macOS, the section needs Node.js 22.12 or newer, or T3 Code's own runtime.
  With an older Node.js, the launcher turns it off and the RTL fix still works.

To turn the section off, use the **Repository status** switch in the Extras
section of T3 Code's Labs settings. See [Extras settings](#extras-settings).

## Usage limits

The sidebar footer shows the usage limits of the AI accounts set up in T3
Code, between the buttons at the left and the update button at the right. It
shows the busiest accounts as small chips in the color you gave each account
in T3 Code, with its highest percent, as many as the free width holds: a
wider sidebar shows more accounts. T3 Code's buttons never move.

Each chip has an arrow for T3 Code's pace of that limit: up when the account
spends faster than the window passes, down when it has headroom left, and
right when it is on pace. A limit that is used up shows a blocked sign, and a
limit without a known reset shows a dot.

Point at the chips, or move to them with the keyboard and press Enter, to see
every account. Each limit has its own line with its percent and pace, such as
a separate weekly limit for one model. The reset shows in words, such as
"resets in 21h", on the account's line when all its limits reset together, as
with Claude, and on each limit's line when they differ. Point at a reset to see
its date and time, or at an account's name to see when T3 Code last checked
it. Escape closes the list.

- The numbers come from the files where T3 Code keeps what it last read about
  each account. The fix only reads them, and only the account's name, color,
  provider, and limit windows reach the page.
- An account shows while T3 Code checked it in the last 24 hours. Its row in
  the list fades when the check is older than 30 minutes.
- In T3 Code's WSL-only mode, T3 Code keeps this data inside WSL, so the chips
  do not show. Usage sources such as CLIProxy are not shown either.
- The account list holds the accounts whose provider reports usage, also while
  none of its limits is open. Providers that never report usage are left out.
- Choose the accounts in the Extras section, or turn the chips off there.

## Extras settings

The Labs page of T3 Code's settings ends with an **Extras** section, added by
the fix:

- **Right-to-left layout** turns the mirrored layout of the whole app on or
  off. It is on by default.
- **Usage limits in the sidebar** turns the chips on or off.
- **Accounts** chooses the accounts the chips show. An account you hid stays in
  the list, so you can show it again.
- **Repository status** turns the repository status section on or off. On
  macOS with an older Node.js, the switch is off and says why.

Changes apply at once, without a restart. They are saved in `settings.json`
beside `rtl.css` in the installed folder. The installer never writes this file,
so an update keeps your choices, and a file that the fix cannot read is never
overwritten: the section says so, and changes wait until you fix or delete it.
An existing `{ "repoStatus": false }` keeps working. Problems are written once
each to `launcher.log` in the same folder.

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
after a T3 Code update if the fix stops loading. An update that renames the
app, such as T3 Code 0.1.0 renaming "T3 Code (Alpha)" to "T3 Code (Beta)",
replaces its shortcuts with ones that open T3 Code without the fix.

When T3 Code installs an update, it reopens itself without the fix and points
its Start Menu shortcut at the app again. The fix notices the update, points
the shortcut back at the fix, and shows a message asking you to quit T3 Code
and open it again from its shortcut. If the update renamed the app, the message
asks you to run the install command again. Opening T3 Code from a shortcut
also repairs any shortcut that an update changed.

Fully quit T3 Code after installation. Open it again from the Desktop shortcut
or the Start menu shortcut updated by the installer. The installer backs up the
original shortcuts first.

If T3 Code is installed in a non-default location, pass the executable path:

```powershell
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/ShlomiPorush/t3code-rtl-fix/main/windows/install.ps1'))) `
  -T3CodePath "D:\Apps\T3 Code (Beta).exe"
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
loads. You can drag it to the Dock in place of the original. When T3 Code
reopens itself after an update, it opens without the fix. Quit it with Cmd+Q
and open **T3 Code RTL** again.

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

T3 Code draws its element annotation window inside the browser preview, in a
closed shadow root. In the preview, the launcher only listens for that window
to take focus and then sets the direction of its comment field. The content of
the previewed page is not changed.

On Windows, each time T3 Code exits, the launcher ends and a small helper
waits a few minutes for an update to reopen T3 Code. When one does, the helper
repairs the shortcuts and shows the message once. It only touches shortcuts
that the installer of the fix changed, so the uninstaller still restores all
of them.

The connection uses inherited process pipes. It does not open a local TCP
debugging port, and the RTL fix does not send data over the network.

For the repository status section, the launcher adds a DevTools binding to
the T3 Code page. The page reports the address of the open thread through it,
and the launcher answers with the counts. The launcher runs `git` and `gh`
without a shell, and the page receives only the repository name, the counts,
and their details. When a row or a link is clicked, the launcher opens only a GitHub page
of that repository that it sent to the page itself. The only network requests
are the ones `gh` makes to GitHub.

The usage chips and the Extras section run in a separate script world that
the launcher creates in the T3 Code page. Their binding exists only in that
world, so T3 Code's own scripts and the frames inside the page, such as HTML
that an agent made, cannot call it or receive its data. What the chips and the
section show is ordinary text in T3 Code's page. The page can change only
the three Extras settings, one at a time, and the launcher writes them to its own
`settings.json`, never to a T3 Code file. It refuses when its folder is inside
T3 Code's data folder.

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
  and in the right-to-left layout may need an update when that happens. The usage chips and the Extras section
  then stop showing until the fix is updated.
- The usage chips and the Extras section are not added to T3 Code's
  development build.
- In the right-to-left layout, a new window can show T3 Code's own layout for
  a moment when T3 Code first opens, before the fix reaches it.
- The first installation cannot inject into an instance that is already open.
  Fully quit and reopen the app once.

## Test

Contributors need Node.js 18 or newer. On Windows with Microsoft Edge installed:

```powershell
npm test
```

The smoke tests verify CSS injection through a Chromium debugging pipe, and the
right-to-left layout in a real browser: mirrored copies of the stylesheets,
the exact original layout when it is turned off, and a mirrored resize drag. A
separate regression test performs a complete installation and removal under
Windows PowerShell 5.1. The unit tests also verify that no TCP debugging port is
enabled and that shipped user-facing text contains no Hebrew.

## Credits

- macOS support was contributed by [@sagistiki](https://github.com/sagistiki)
  in [#27](https://github.com/ShlomiPorush/t3code-rtl-fix/pull/27).

## License

[MIT](LICENSE)

# Home page

The Home page shows where every project stands, in place of the new thread that
T3 Code opens with. Turn on **Home page** in the Extras section of T3 Code's
Labs settings. The option is off by default. When you change it, T3 Code's
windows reload, and running sessions keep running.

Home opens when T3 Code starts, when you click the T3 Code logo, and wherever
T3 Code goes back to its start page, such as after you delete the open thread.

## The map

Each project with something open has a row. A mark shows how many items stand at
a station. Rest the pointer on a mark, or focus it, to see the items and open
them. Click a project's name to open its page.

| Station | What it counts |
|---|---|
| Working | Agents that run now in a connected computer. An agent that waits for your answer is not counted. |
| Pull request | Open pull requests that are not ready: drafts, running or failed checks, conflicts, or a merge that the branch rules block. |
| Ready to merge | Pull requests that GitHub can merge now. In a repository without checks, the item says "no checks". |
| Not released | Commits on the default branch since the last release. "!" means that the default branch fails its checks. |
| Last release | The newest release and its age. |

- Hollow marks are dependency updates by Dependabot or Renovate. The totals do
  not count them.
- A "+" means that there are more pull requests than the 20 that were read last.
- Projects of the same repository, such as one on each computer, are one row.
- Projects without open items are listed below the map. Projects that GitHub did
  not answer for have a list of their own.

Home does not change anything on GitHub.

## Where the data comes from

Projects and agents are T3 Code's own live data. GitHub is read with the `gh`
command, which must be installed and signed in. The fix reads it only while
Home is open in a visible window, and reads a repository again after five
minutes at the earliest. Each read of a repository uses one point of GitHub's
hourly limit of 5,000.

## When T3 Code changes

When a T3 Code update changes the code of the start page, T3 Code shows its own
start page, and the launcher writes one line to `launcher.log`. T3 Code's own
start page also shows when Home fails, and when there are no projects.

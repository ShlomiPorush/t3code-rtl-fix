# Home page

The Home page shows what is in the middle in every project, in place of the new
thread that T3 Code opens with. Turn on **Home page** in the Extras section of
T3 Code's Labs settings. The option is off by default. When you change it, T3
Code's windows reload, and running sessions keep running.

Home opens when T3 Code starts, when you click the T3 Code logo, and wherever
T3 Code goes back to its start page, such as after you delete the open thread.

## In the middle

Each project with open work has a card. Open work is:

- Threads that you did not settle in T3 Code. A snoozed thread is hidden until
  T3 Code itself brings it back.
- Open pull requests that are not dependency updates by Dependabot or Renovate.

Projects that are pinned in T3 Code come first and always have a card. Next are
projects with a working agent, and then the projects you used last. Projects of
the same repository, such as one on each computer, are one card.

Cards and their rows keep their places while Home is open. A new card goes to the
end, and a new thread to the top of its card. The order is made again when you
open Home.

| Mark | What it says |
|---|---|
| Dot that pulses | An agent works, in a connected computer. The card is lit. |
| Amber dot | The thread waits for your answer or approval. |
| Green dot | The agent finished, and you did not open the thread since. |
| Red dot | The last run stopped on an error. |
| Ring | An open thread that nobody works on. |

The head of a card says these states in words. Rest the pointer on a dot to see
the state of its thread.

A pull request is on the row of the thread it is linked to, or has a row of its
own. "Ready to merge" means that GitHub can merge it now. In a repository
without checks, the row says "no checks". Threads that had no activity for two
weeks come last, in a weaker color. A card shows five rows, and its button shows
the others.

Click a project's name to open its own page, which also lists its dependency
updates.

## Counts

| Count | What it counts |
|---|---|
| Issues | Open issues. |
| Pull requests | Open pull requests, and how many of them are dependency updates. When there are more than 30, only the total. |
| Security alerts | Open alerts of Dependabot, code scanning, and secret scanning together, and how many are critical, or else high. |

The security count is red when it has critical or high alerts. It covers only
the sources that are on in the repository and that your account may read. Rest
the pointer on it to see which. A count that GitHub does not give is left out,
so 0 always means that GitHub answered 0.

Projects without open work are listed below the cards. Projects whose pull
requests GitHub did not give, or gave in part, have a list of their own.
"Read in part" means that GitHub did not give everything about the project, or
that it has more than the 30 pull requests that were read last.

Home does not change anything on GitHub.

## Where the data comes from

Projects and threads are T3 Code's own live data. GitHub is read with the `gh`
command, which must be installed and signed in. Answers are kept in
`home-cache.json` in the folder of the fix, so Home shows them at once, also
after a restart of T3 Code. The file holds titles of pull requests and counts,
and no sign-in. A repository is read again:

- When you open Home or come back to its window, and the answer is older than 15
  minutes.
- Once an hour while T3 Code is open, after Home was opened.

When **Repository status** is on, the section in the thread details card reads
the issues, pull requests, and alerts of the thread's repository, and Home takes
them over without a request of its own. Whether a pull request can be merged is
only in Home's own reads.

A read of a repository uses one point of GitHub's hourly GraphQL limit, and a
read of its alerts at least three requests of the hourly REST limit. Both limits
are 5,000. Secrets that secret scanning found are hidden by GitHub and are not
read.

## When T3 Code changes

When a T3 Code update changes the code of the start page, T3 Code shows its own
start page, and the launcher writes one line to `launcher.log`. T3 Code's own
start page also shows when Home fails, and when there are no projects.

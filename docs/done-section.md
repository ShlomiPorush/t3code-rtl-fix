# Done section in the boring sidebar

The Done section collects the threads that finished and that you have not
opened since, from all the project folders of the boring sidebar (Labs > Boring
sidebar, group by project). Turn on **Done section in the boring sidebar** in
the Extras section of the Labs page. The option is off by default. When you
change it, T3 Code's windows reload, and running sessions keep running.

- The section sits below Working and above Pinned. The thread that finished
  last is first. Click the header to collapse the section.
- A thread is in the section when its last run finished and you have not opened
  it since. Its label is usually Done, or Woke after a snooze. A thread that
  needs approval or input, or that failed, stays in its folder.
- A thread that you open from the section stays there while it is open. When
  you open another thread, it returns to its folder. To put a thread back, use
  **Mark unread** in its menu.
- A thread that finishes while it is open does not enter the section.
- Pinned, snoozed, and settled threads stay where they are.

The option does not depend on the Working section. When a T3 Code update changes
the code that only the Done section needs, the other sidebar changes still apply, and
the launcher writes one line to `launcher.log`.

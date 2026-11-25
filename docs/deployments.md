# Deployments

The repository status section in the thread details card ends with a
**Deployments** group. It shows the GitHub deployment environments of the
thread's repository, such as Production and Preview.

Each row is one environment. It shows how long ago the environment was last
deployed, such as `3h`, and the state of that deployment:

| State | Meaning |
|---|---|
| Active, Deployed | The deployment succeeded. |
| Failed, Error | The deployment failed. |
| In progress, Queued, Pending | The deployment is still running. |
| Waiting | The deployment waits for an approval. |
| Inactive, Abandoned, Unknown | A newer deployment replaced it, it stopped reporting, or GitHub gave a state the fix does not know. |

Point at a row to see the last 10 deployments of that environment, with the
branch or tag, the user or app that deployed, the commit, and the time.

- Click a row to open the deployment history of that environment on GitHub.
- Click a deployment to open its site, when the deployment reports one.
  Only `https` addresses open. A deployment without a site, such as one
  that reports only its log, is not a link.
- Drag a deployment into the message box to quote its branch or commit. The
  quote leaves out the site address, which can hold an access token.

## Which environments show

- Only deployments reported to GitHub show. GitHub Actions jobs with an
  `environment`, and services such as Vercel, Netlify, and Render, report them.
  A deployment made over SSH or by a script that does not report to GitHub does
  not show.
- An environment shows when its last deployment is from the last 30 days.
  Repositories keep old environments, so a group of every environment would
  be long.
- An environment whose last deployment was destroyed, such as a preview of a
  closed pull request, does not show.
- The group reads the first 50 environments of the repository.
- When GitHub does not answer about deployments, or your account cannot read
  them, the group does not show. The other rows still show.

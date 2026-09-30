# Beta channel

Run the latest verified code — not just the latest npm publish. The beta
channel tracks every **fully-successful main commit**: a commit counts only
when the latest runs of the **CI**, **Prebuilds**, and **CodeQL** workflows
are all completed with a green conclusion.

## Opt in

```sh
memos beta enable
memos beta status    # enabled / disabled
memos beta disable
```

Beta is off by default. With it on, memos checks at most every 6 hours
(cached, so normal commands stay fast) whether a newer green commit exists,
and prints a notice to stderr — stdout stays clean for scripts and `--json`:

```
[memos] Beta update available: 1d85f70 — fix(dashboard): search() takes single arg
[memos] Run `memos update` to install it.
```

The check never breaks anything: network failures are silent, and the notice
never appears for the commands that manage updates themselves.

## Update

```sh
memos update            # check, prompt, then install the newest green commit
memos update --check    # just report what's available
memos update --yes      # install without prompting (for scripts)
memos update --json     # machine-readable status
```

`memos update` works whether or not beta is enabled — beta just adds the
automatic prompt.

Installing a beta build:

1. Downloads the commit tarball from GitHub.
2. Runs `pnpm install --frozen-lockfile` and `pnpm build` (pnpm from your
   PATH, or via corepack — the repo is pnpm-only).
3. Repoints `$MEMOS_HOME/bin/memos` at the fresh build, using the same node
   that runs your current memos.
4. Writes the commit SHA to `$MEMOS_HOME/.install-ref` so future checks know
   what's installed.
5. Keeps the two newest source checkouts under `$MEMOS_HOME/beta/` and prunes
   older ones.

Your database is untouched — only the CLI code changes.

## Notes

- A commit whose CI is still queued or running doesn't count; `memos update`
  walks back up to 10 commits to find the newest green one. If none qualifies,
  it tells you to try again later.
- The one-line installer records its baseline in `$MEMOS_HOME/.install-ref`
  (e.g. `npm:latest`), so beta users coming from `install.sh` are correctly
  detected as behind main.
- Re-running `install.sh` switches you back to the npm release track; running
  `memos update` switches you back to beta-from-source. `.install-ref` always
  reflects the last thing that wrote it.
- GitHub's unauthenticated API allows 60 requests/hour per IP; the 6-hour
  cache keeps well under that.

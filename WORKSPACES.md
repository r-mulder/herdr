# Personal Herdr worktrees

The active layout is **personal-workspace**, cloned from Herdr's `main` layout.
Shipped files and the existing keybindings-help feature are unchanged.

## Use it

- Click the **branch icon** on a Git space to create a worktree there. The
  worktree opens in its own space, nested below its parent. The space context
  menu and tab-bar **+** menu also offer New/Open worktree.
- **Cmd+Shift+N** opens New worktree for the current space. Enter a branch name
  to create its nested worktree. **Cmd+N** still creates a top-level space.
- Optionally paste a **Bash setup script** into the New worktree dialog.
  Enter adds a new script line; **Cmd/Ctrl+Enter** or **Create worktree** submits.
  The script runs in the newly created checkout, on its machine, before its
  terminal opens. Blank skips setup. **Save repo default** remembers the script
  for future worktrees of that repository; ordinary edits are one-off until saved.
- A failed setup leaves the checkout and partial work intact. Edit the script
  and choose **Retry setup**, or **Open worktree without retrying setup**.
  Retrying reuses the same checkout instead of creating it again.
- Click a space's **×** to soft-close its whole worktree. Its tabs, panes,
  agents and terminals keep running; they are hidden from the normal lists.
  Other worktrees belonging to that repository remain open.
- **Recently closed** sits at the bottom of Spaces and starts collapsed.
  Expand it and click **Reopen** to return to the same running worktree.
  Reopening cancels expiry. Closing again starts a fresh four-day period.
- Closing the last tab/pane, including with **Cmd+W / Cmd+Shift+W**, soft-closes
  the worktree too. Closing a tab/pane when others remain keeps its normal
  behavior: that tab/pane's terminals end.
- Space/agent navigation and the space pickers skip closed worktrees.

## Bash setup

Paste commands directly, or invoke a repository script:

```bash
bash ./scripts/setup.sh
```

Setup uses `bash -e -o pipefail`: a failing command or pipeline stops setup.
It has a ten-minute timeout, and requires Bash on the worktree's machine.
Output is shown on failure and is not saved. Scripts are saved only with the
explicit **Save repo default** control. Nothing is discovered or executed
automatically from a repository. Use only scripts you trust: they run with your permissions.
Retries are explicit and may repeat earlier successful steps, so setup scripts
should be safe to rerun. Closing/reloading the dialog or quitting the app is not
a guaranteed cancellation of a process already started; its files stay on disk
and can be recovered through **Open worktree**.

### Per-repository defaults

Defaults are stored in **`~/.config/herdr-app/worktree-scripts.json`** (or the
current `HERDR_APP_HOME`). In New worktree:

1. Enter your setup script and click **Save repo default**. You do not need to
   create a worktree just to save its default.
2. The next New worktree dialog for that repository pre-fills the saved script.
   You can edit or clear it for one run without changing the saved default.
3. **Remove default** forgets the saved value. It leaves the current draft
   intact for this run; the next dialog starts blank.

The main checkout and its linked worktrees share one default, identified by
Git's absolute common directory. Separate clones and different machines keep
separate defaults, even if their repositories have the same name. Preferences
are local to this Herdr installation, including scripts for remote machines.

You can also edit the file directly; the next dialog reads it afresh:

```json
{
  "version": 1,
  "repositories": [
    {
      "machine": null,
      "gitDir": "/absolute/path/to/repo/.git",
      "script": "bash ./scripts/setup.sh"
    }
  ]
}
```

Use `null` for this machine, or Herdr's machine name for a remote. The Git
directory is reported by `git rev-parse --path-format=absolute --git-common-dir`.
Scripts are **plain text**, not encrypted; use environment variables rather
than embedding passwords or tokens. Saving preserves other repositories'
entries; conflicting edits are rejected instead of overwritten. Invalid JSON
or invalid entries are never reset silently: fix the file and reopen the dialog.

## Four-day cleanup

After four days the worktree's terminals end and its Recently closed entry
is cleared. Cleanup runs on layout initialization and every 30 seconds while
this layout is active. Offline machines wait until they are available.

A linked Git worktree is removed only after core confirms that its space
has closed and Git verifies that:

- its recorded repository and checkout identities still match;
- no other space or nested worktree is using it and it is not locked;
- it has no uncommitted, untracked or ignored local files;
- it has no commits absent from known remote-tracking branches;
- it has no submodules needing additional protection.

Cleanup **never** force-removes a worktree, deletes a branch or removes the
main checkout or an ordinary folder. If verification fails, the worktree
entry expires but its files stay on disk; a notification explains why.
Remote-tracking refs are used as last known; cleanup does not fetch.

If tabs or panes were added to a closed space outside this UI, cleanup is deferred and
the entry remains available to reopen rather than terminating new work.

Soft-close is a personal-layout convention, not a native core archive. Other
layouts, direct `herdr-app`/`hc` commands and terminal-program exits can bypass
it. Keeping a worktree closed does not suspend its processes or suppress the
core's notifications. Reopening does not restart an agent that has exited.

## Files and validation

- `layouts/personal-workspace.json` and its SVG preview.
- `mods/personal-spaces/`: nested spaces, creation/close controls and accordion.
- `mods/personal-workspaces/`: status bar, empty view and lifecycle controller.
- Other `mods/personal-*/` clones integrate menus, navigation and close actions.
- Archive state is persisted through Herdr's shared-state API. Do not edit
  `shared.json` while the app runs.
- `keys.json` adds overrides only for `layout:personal-workspace`.
  `keys.before-personal-workspaces.json` is the pre-change backup.

Automated lifecycle/Git safety tests (only disposable repositories):

```sh
node --test ~/.config/herdr-app/mods/personal-workspaces/lifecycle.test.mjs
node --test ~/.config/herdr-app/mods/personal-workspaces/commands.test.mjs
node --test ~/.config/herdr-app/mods/personal-worktree/create.test.mjs
node --test ~/.config/herdr-app/mods/personal-worktree/defaults.test.mjs
herdr-app check ~/.config/herdr-app/mods/personal-workspaces
herdr-app check ~/.config/herdr-app/mods/personal-spaces
herdr-app check ~/.config/herdr-app/mods/personal-worktree
```

All personalized mods were also checked individually. `live-check.json` in
the controller folder records the live disposable-worktree verification.
`mods/personal-worktree/live-setup-check.json` records live Bash success and
failure/recovery rendering checks. `mods/personal-worktree/live-defaults-check.json`
records native default persistence, repo isolation and linked-worktree inheritance.
Existing layout and storage identifiers
are kept for compatibility; visible wording uses **worktree**.

To return to the unmodified shipped interface without deleting anything:

```sh
herdr-app do layout.switch '{"name":"main"}'
```

Personal copies survive app updates, but do not automatically receive future
changes to their shipped source mods. The emergency escape hatch remains
**Ctrl+Alt+Shift+Escape**.

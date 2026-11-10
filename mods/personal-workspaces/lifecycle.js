// Host-independent lifecycle, also exercised against disposable Git repositories.
export const CLOSED = "personal.workspaces.closed";
export const REQUESTS = "personal.workspaces.requests";
export const RETENTION = 4 * 24 * 60 * 60 * 1000;
export const singleLine = text => text.replace(/\r?\n$/, "");
export const inside = (path, root) => path === root || path.startsWith(`${root}/`);

export function place(space, panes) {
  const tabs = new Set(space.tabs.map(tab => tab.id));
  return panes.find(pane => tabs.has(pane.tab) && pane.cwd)?.cwd || space.folder;
}

export function worktrees(text) {
  const result = [];
  let entry;
  for (const field of text.split("\0")) {
    if (field.startsWith("worktree ")) {
      entry = { path: field.slice(9), locked: false, bare: false };
      result.push(entry);
    } else if (entry && (field === "locked" || field.startsWith("locked "))) entry.locked = true;
    else if (entry && field === "bare") entry.bare = true;
  }
  return result;
}

export async function snapshot(folder, on, git) {
  const path = singleLine(await git(folder, ["rev-parse", "--show-toplevel"], on));
  const common = singleLine(await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on));
  const list = worktrees(await git(path, ["worktree", "list", "--porcelain", "-z"], on));
  if (!list[0] || list[0].bare || !list.some(tree => tree.path === path)) throw new Error("Could not identify the main checkout safely.");
  return { path, common, main: list[0].path, linked: path !== list[0].path };
}

// No shell, force, branch deletion, prune or recursive filesystem deletion.
// Unknown state is a reason to keep the checkout, never permission to delete it.
export async function removeSafely(saved, on, git, inUse, current) {
  if (!saved?.linked) return null;
  const check = () => {
    if (!current()) throw new Error("Cleanup cancelled.");
    if (inUse(saved.path, on)) throw new Error("Another worktree is using this checkout.");
  };
  check();
  const fresh = await snapshot(saved.path, on, git);
  if (!fresh.linked || fresh.path !== saved.path || fresh.common !== saved.common || fresh.main !== saved.main) throw new Error("The checkout's repository identity changed.");
  const list = worktrees(await git(saved.main, ["worktree", "list", "--porcelain", "-z"], on));
  if (list.find(tree => tree.path === saved.path)?.locked) throw new Error("The worktree is locked.");
  if (list.some(tree => tree.path !== saved.path && inside(tree.path, saved.path))) throw new Error("Another worktree is nested inside this checkout.");
  if (await git(saved.path, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], on)) throw new Error("It has uncommitted or untracked work.");
  if (await git(saved.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], on)) throw new Error("It contains ignored local files.");
  if ((await git(saved.path, ["ls-files", "--stage", "-z"], on)).split("\0").some(line => line.startsWith("160000 "))) throw new Error("It contains submodules; their local history is being kept.");
  if (singleLine(await git(saved.path, ["rev-list", "--max-count=1", "HEAD", "--not", "--remotes"], on))) throw new Error("It has commits not present on any known remote branch.");
  check();
  await git(saved.main, ["worktree", "remove", "--", saved.path], on);
  return null;
}

export class WorkspaceLifecycle {
  constructor(host) {
    this.host = host;
    this.sweeping = false;
  }

  entries() { return this.host.shared(CLOSED) ?? {}; }
  ready(on) { return this.host.machines().some(machine => (machine.name ?? null) === (on ?? null) && machine.layout === "ready"); }
  same(entry) { return this.entries()[entry.id]?.token === entry.token; }
  write(entry) {
    if (this.same(entry)) this.host.setShared(CLOSED, { ...this.entries(), [entry.id]: entry });
  }
  forget(entry) {
    if (!this.same(entry)) return;
    const entries = { ...this.entries() };
    delete entries[entry.id];
    this.host.setShared(CLOSED, entries);
  }

  async git(cwd, args, on) {
    const result = await this.host.exec("git", args, { cwd, on, timeout: 30000 });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "Git could not verify the checkout.");
    return result.stdout;
  }

  async close(id) {
    const space = this.host.spaces().find(space => space.id === id);
    if (!space || this.entries()[id]) return;
    const now = this.host.now();
    const entry = {
      id, name: space.name, named: space.named, machine: space.machine ?? null,
      folder: place(space, this.host.panes()), tabIds: space.tabs.map(tab => tab.id),
      paneIds: this.host.panes().filter(pane => space.tabs.some(tab => tab.id === pane.tab)).map(pane => pane.pane),
      token: `${now}-${Math.random()}`, closedAt: now, expiresAt: now + RETENTION,
      phase: "closed", checkout: null, snapshotError: null,
    };
    this.host.setShared(CLOSED, { ...this.entries(), [id]: entry });
    try { entry.checkout = await snapshot(entry.folder, entry.machine, this.git.bind(this)); }
    catch (error) { entry.snapshotError = String(error.message ?? error); }
    this.write(entry);
  }

  reopen(id) {
    const entry = this.entries()[id];
    if (!entry || entry.phase !== "closed") return;
    if (!this.ready(entry.machine)) {
      this.host.notify({ title: "Cannot reopen yet", body: "This worktree's machine is unavailable. Try again when it reconnects.", level: "warning" });
      return;
    }
    // Cancel retention before selecting. Existing processes are never restarted.
    try {
      if (this.host.spaces().some(space => space.id === id)) this.host.run("space.select", { id });
      else {
        this.host.run("space.new", { folder: entry.folder, machine: entry.machine ?? "", ...(entry.named ? { name: entry.name } : {}) });
        this.host.notify({ title: "Worktree reopened", body: "Its original terminals had already ended; a new shell was opened in the saved folder.", level: "info" });
      }
      this.forget(entry);
    } catch (error) {
      this.host.notify({ title: "Could not reopen worktree", body: String(error.message ?? error), level: "error" });
    }
  }

  inUse(path, on) {
    const panes = this.host.panes();
    return this.host.spaces().some(space => {
      if ((space.machine ?? null) !== (on ?? null)) return false;
      const tabs = new Set(space.tabs.map(tab => tab.id));
      return inside(place(space, panes).replace(/\\/g, "/"), path) || panes.some(pane => tabs.has(pane.tab) && pane.cwd && inside(pane.cwd.replace(/\\/g, "/"), path));
    });
  }

  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const entry of Object.values(this.entries())) {
        if (!Number.isFinite(entry.expiresAt) || entry.expiresAt > this.host.now() || !this.same(entry) || !this.ready(entry.machine)) continue;
        const space = this.host.spaces().find(space => space.id === entry.id);
        if (space) {
          const ids = space.tabs.map(tab => tab.id);
          const paneIds = this.host.panes().filter(pane => ids.includes(pane.tab)).map(pane => pane.pane);
          if (ids.some(id => !entry.tabIds.includes(id)) || (entry.paneIds && paneIds.some(id => !entry.paneIds.includes(id)))) {
            this.write({ ...entry, reason: "Its tabs or panes changed while closed. Reopen to review it." });
            continue;
          }
          if (entry.phase !== "closing" || this.host.now() - (entry.closeRequestedAt ?? 0) > 60000) {
            this.write({ ...entry, phase: "closing", closeRequestedAt: this.host.now() });
            try { this.host.run("space.close", { id: entry.id, confirmed: true }); }
            catch (error) { this.write({ ...entry, phase: "closed", reason: String(error.message ?? error) }); }
          }
          // Wait for core's document to confirm it actually closed. Never remove
          // files while a terminal in the expired space could still be writing.
          continue;
        }
        let kept = null;
        try {
          if (entry.checkout) await removeSafely(entry.checkout, entry.machine, this.git.bind(this), this.inUse.bind(this), () => this.same(entry) && this.host.now() >= entry.expiresAt);
          else kept = "The checkout could not be verified; its files were left untouched.";
        } catch (error) { kept = String(error.message ?? error); }
        if (!this.same(entry)) continue;
        this.forget(entry);
        if (kept) this.host.notify({ title: `Closed worktree cleared: ${entry.name}`, body: `Files kept at ${entry.checkout?.path ?? entry.folder}. ${kept}`, level: "warning", timeout: 12000 });
      }
    } finally { this.sweeping = false; }
  }
}

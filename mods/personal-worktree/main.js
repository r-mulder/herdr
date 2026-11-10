// Worktree dialog: { space, action: "new" | "open" | "remove" } or
// { folder, machine } for a repo without a space; optional { branch, tab, argv, script }.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Scrollbar } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home, shared, setShared, appHome, readTextFile, writeTextFile } from "herdr";
import { DEFAULTS_FILE, loadRepoDefault, writeRepoDefault } from "./defaults.js";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Checkouts go to <ROOT>/<repo>/<branch, slashes as dashes>.
const ROOT = (home) => `${home}/.herdr/worktrees`;
// Home as ~ (git says C:/Users/x where Windows says C:\Users\x).
const tilde = (path, userHome) => {
  const [p, h] = [path, userHome].map((s) => s.replace(/\\/g, "/"));
  return p.startsWith(h) ? `~${p.slice(h.length)}` : path;
};
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

// Every checkout of a repo (`git worktree list`), the main one first, then
// the most recently committed: { path, branch, main, at }.
async function checkouts(repo, on) {
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  if (!list.ok) return [];
  const refs = await git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], on);
  const when = new Map(refs.out.split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch, main: out.length === 0, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  return out.sort((a, b) => b.main - a.main || b.at - a.at);
}

// The space showing a checkout: its first terminal is in it (the deepest checkout wins).
function spaceOf(path, all, on, spaceList, paneList) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
  return spaceList.find((s) => (s.machine ?? null) === (on ?? null) && (() => {
    const at = place(s, paneList)?.replace(/\\/g, "/");
    if (!at || !inside(at, path)) return false;
    return !all.some((c) => c.path !== path && c.path.length > path.length && inside(at, c.path));
  })());
}

async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The submodule repos git keeps for a checkout (nested ones too, checked out
// or not): { name, dir, pinned }. `config` is the args that read its
// .gitmodules; `pinned` is the commit its parent records ("" if none).
async function modules(gitDir, config, on, out = [], parent = "") {
  const keys = await git(gitDir, ["--git-dir", gitDir, "config", ...config, "-z", "--get-regexp", "^submodule\\..*\\.path$"], on);
  if (!keys.ok) return out; // no .gitmodules, or no submodules in it
  // -z: "key\nvalue" records ended by NUL, so names and paths may hold spaces.
  for (const record of keys.out.split("\0").filter(Boolean)) {
    const at = record.indexOf("\n");
    const name = record.slice("submodule.".length, at - ".path".length);
    const dir = `${gitDir}/modules/${name}`;
    if (!(await git(gitDir, ["--git-dir", dir, "rev-parse", "--git-dir"], on)).ok) continue; // never checked out
    const pinned = await git(gitDir, ["--git-dir", gitDir, "rev-parse", `HEAD:${record.slice(at + 1)}`], on);
    // Names are only unique within their parent: nested ones carry its name.
    out.push({ name: parent + name, dir, pinned: pinned.ok ? pinned.out : "" });
    if ((await git(gitDir, ["--git-dir", dir, "cat-file", "-e", "HEAD:.gitmodules"], on)).ok) await modules(dir, ["--blob", "HEAD:.gitmodules"], on, out, `${parent + name}/`);
  }
  return out;
}

// The worktree's submodules, and the names of those with commits that exist
// nowhere else: not on a remote, and not the commit the parent pins (git
// fetches that by hash, so it is often on no remote branch here).
async function submodules(top, on) {
  const gitDir = await git(top, ["rev-parse", "--absolute-git-dir"], on);
  if (!gitDir.ok) throw new Error(gitDir.err || "git rev-parse failed.");
  const mods = await modules(gitDir.out, ["--file", `${top}/.gitmodules`], on);
  const unpushed = [];
  for (const m of mods) {
    const local = await git(gitDir.out, ["--git-dir", m.dir, "rev-list", "-n1", "--all", "--not", "--remotes", ...(m.pinned ? [m.pinned] : [])], on);
    if (!local.ok) throw new Error(local.err || `Couldn't check submodule ${m.name}.`);
    if (local.out) unpushed.push(m.name);
  }
  return { mods, unpushed };
}

// The repo a folder belongs to: its main checkout and name, and whether
// the folder is itself a linked worktree. null outside git.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok) return null;
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { top: top.out, main, gitDir: common.out, name: main.split("/").pop(), linked: main !== top.out };
}

export default class Worktree extends View {
  init(_props, cx) {
    this.on = this.space()?.machine;
    this.userHome = this.on ? null : home();
    this.opening = props()?.action === "open";
    this.text = props()?.branch ?? "";
    this.list = undefined; // open: the checkouts, once read
    this.at = 0;
    this.input = InputState.new({ value: this.text, placeholder: this.opening ? "filter worktrees" : "branch name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.script = TextareaState.new({ value: props()?.script ?? "", placeholder: "# Optional setup, for example:\nbash ./scripts/setup.sh", rows: 4 });
    this.scriptFocused = false;
    this.scriptEdited = false;
    this.savedScript = null;
    this.defaultError = "";
    this.defaultNotice = "";
    this.defaultSaving = false;
    this.defaultsIO = { path: `${appHome()}/${DEFAULTS_FILE}`, readTextFile, writeTextFile };
    this.script.on("change", (_e, cx) => { this.scriptEdited = true; if (!this.busy) this.error = ""; this.defaultNotice = ""; cx.notify(); });
    this.script.on("focus", (_e, cx) => { this.scriptFocused = true; cx.notify(); });
    this.script.on("blur", (_e, cx) => { this.scriptFocused = false; cx.notify(); });
    this.script.on("submit", (_e, cx) => this.go(cx));
    this.created = null;
    this.setupComplete = false;
    this.opened = false;
    this.stage = "";
    if (props()?.action !== "remove") {
      this.input.focus();
      cx.timer.after(600, () => { if (!this.scriptFocused && !this.busy && !this.created) this.input.focus(); });
    }
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.dirty = false;
    this.unpushed = [];
    this.handle = cx.focus_handle();
    if (props()?.action === "remove") this.handle.focus();
    cx.spawn(async (cx) => {
      try {
        if (this.on) {
          let result;
          try { result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on }); } catch {}
          if (!result || result.code !== 0 || !result.stdout.trim()) result = await exec("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write($HOME)"], { on: this.on });
          if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the remote home folder.");
          this.userHome = result.stdout.trim().replace(/\\/g, "/");
        }
        this.folder = props()?.folder || place(this.space()) || this.userHome;
        // The repo is set last: Enter does nothing until the warnings it consents to are known.
        const repo = await repoOf(this.folder, this.on);
        if (repo && props().action === "remove") {
          this.dirty = (await git(repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on)).out !== "";
          this.unpushed = (await submodules(repo.top, this.on)).unpushed;
        }
        if (repo && this.opening) this.list = await checkouts(repo, this.on);
        if (repo && !this.opening && props().action !== "remove") await this.loadDefault(repo);
        this.repo = repo;
        cx.notify();
        if (props().branch && !this.defaultError) await this.work(cx);
      } catch (error) { this.repo = null; this.error = String(error); cx.notify(); }
    });
  }

  space() {
    const p = props() ?? {};
    return spaces().find((s) => s.id === p.space) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : undefined);
  }

  async loadDefault(repo) {
    try {
      this.savedScript = await loadRepoDefault(repo, this.on, this.defaultsIO);
      // Do not overwrite an explicit script or a draft typed during Git/file I/O.
      if (this.savedScript !== null && !this.scriptEdited && typeof props()?.script !== "string") this.script.set_value(this.savedScript);
    } catch (error) { this.defaultError = String(error.message ?? error); }
  }

  async storeDefault(remove, cx) {
    if (!this.repo || this.busy || this.defaultSaving || this.defaultError) return;
    const script = remove ? null : this.script.value();
    this.defaultSaving = true;
    this.defaultNotice = "";
    cx.notify();
    try {
      await writeRepoDefault(this.repo, this.on, script, this.savedScript, this.defaultsIO);
      this.savedScript = script;
      this.defaultNotice = remove ? "Default removed; current script kept for this run." : "Repo default saved.";
    } catch (error) { this.defaultNotice = `Not saved: ${String(error.message ?? error)}`; }
    finally { this.defaultSaving = false; cx.notify(); }
  }

  close() {
    if (this.busy || this.defaultSaving) return;
    closeOverlay(props().overlay);
  }

  go(cx) {
    if (this.busy || this.defaultSaving || this.defaultError || !this.repo) return;
    cx.spawn(async (cx) => this.work(cx));
  }

  async work(cx) {
    if (this.busy || this.defaultSaving || this.defaultError || !this.repo) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try { this.error = props().action === "remove" ? await this.remove() : await this.create(cx); }
    catch (error) { this.error = String(error); }
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  async create(cx) {
    const branch = this.created?.branch ?? this.text.trim();
    const script = this.script.value();
    if (!branch) return "Type a branch name.";
    if (!slug(branch)) return "Use a branch name containing a letter or number.";
    if (!this.created) {
      this.stage = "Creating worktree…";
      cx?.notify();
      const path = `${ROOT(this.userHome)}/${this.repo.name}/${slug(branch)}`;
      const exists = (await git(this.repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.on)).ok;
      const add = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"];
      const result = await git(this.repo.top, add, this.on, 600_000);
      if (!result.ok) return result.err || "git worktree add failed.";
      this.created = { path, branch };
      this.rememberParent(path);
    }
    if (!this.setupComplete) {
      if (script.trim()) {
        this.stage = "Running Bash setup…";
        cx?.notify();
        try {
          const result = await exec("bash", ["-e", "-o", "pipefail", "-c", script, "herdr-worktree-setup"], { cwd: this.created.path, on: this.on, timeout: 600_000 });
          if (result.code !== 0) {
            const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim().slice(-3000);
            return `Bash setup failed (exit ${result.code}). Worktree kept at ${this.created.path}.\n${output || "No output was returned."}`;
          }
        } catch (error) {
          return `Bash setup could not finish. Worktree kept at ${this.created.path}.\n${String(error.message ?? error).slice(-3000)}`;
        }
      }
      this.setupComplete = true;
    }
    this.stage = "Opening worktree…";
    this.openCreated();
    return "";
  }

  openCreated() {
    if (!this.created || this.opened) return;
    const p = props();
    // Leave spaces unnamed so they follow the checkout folder and nest under the repo.
    run("space.new", { folder: this.created.path, machine: this.on, tab: p.tab, argv: p.argv });
    this.opened = true;
  }

  openWithoutSetup(cx) {
    if (this.busy || !this.created) return;
    try {
      this.setupComplete = true;
      this.openCreated();
      this.close();
    } catch (error) { this.error = String(error.message ?? error); }
    cx.notify();
  }

  shown() {
    const f = this.text.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.branch ?? ""} ${c.path}`.toLowerCase().includes(f));
  }

  open(c) {
    if (!c) return;
    this.close();
    const s = spaceOf(c.path, this.list, this.on, spaces(), panes());
    if (s && shared("personal.workspaces.closed")?.[s.id]) {
      const key = "personal.workspaces.requests";
      setShared(key, [...(shared(key) ?? []), { action: "reopen", id: s.id }]);
    } else if (s) run("space.select", { id: s.id });
    else { this.rememberParent(c.path); run("space.new", { folder: c.path, machine: this.on }); }
  }

  rememberParent(path) {
    const parent = this.space();
    if (!parent?.id || path === this.repo.main) return;
    const key = "personal.workspaces.parents";
    setShared(key, { ...(shared(key) ?? {}), [JSON.stringify([this.on ?? null, path])]: { parent: parent.id } });
  }

  async remove() {
    const s = this.space();
    const status = await git(this.repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on);
    if (!status.ok) return status.err || "git status failed.";
    // git refuses a worktree with submodules unless forced, because their
    // history goes with it. The popup already showed what's at risk; only
    // risk that appeared since it opened gets one more warning.
    const { mods, unpushed } = await submodules(this.repo.top, this.on);
    const changed = (status.out && !this.dirty) || unpushed.some((name) => !this.unpushed.includes(name));
    this.dirty ||= status.out !== "";
    this.unpushed = [...new Set([...this.unpushed, ...unpushed])];
    if (changed) return "It changed since this opened. Enter again removes it anyway.";
    // Terminals first: a shell sitting in the folder keeps it busy on Windows.
    run("space.close", { id: s.id, confirmed: true });
    const force = this.dirty || mods.length > 0;
    const r = await git(this.repo.main, ["worktree", "remove", ...(force ? ["--force"] : []), this.repo.top], this.on, 600_000);
    return r.ok ? "" : r.err || "git worktree remove failed.";
  }

  key(e, cx) {
    if (e.key === "escape") { cx.stop_propagation(); return this.close(); }
    if (!this.opening && e.key === "enter" && (e.modifiers.platform || e.modifiers.control)) { cx.stop_propagation(); return this.go(cx); }
    if (this.opening) {
      const n = this.shown().length;
      if (e.key === "enter") this.open(this.shown()[this.at]);
      else if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (e.key === "enter" && props()?.action === "remove") return this.go(cx);
  }

  renderOpen(t) {
    const r = this.repo;
    const rows = this.shown();
    const all = this.list ?? [];
    const spaceList = spaces();
    const paneList = panes();
    const row = (c, i) => {
      const on = i === this.at;
      const there = spaceOf(c.path, all, this.on, spaceList, paneList);
      return v_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(44)
        .px(10)
        .justify_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.open(c))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.branch ?? "detached"))
            .when(c.main, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("main checkout")))
            .when(Boolean(there), (el) => el.child(div().flex_none().text_size(11).text_color(t.accent).child(shared("personal.workspaces.closed")?.[there.id] ? "reopen" : "open")))
            .when(!there && c.at > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(ago(c.at)))),
        )
        .child(div().truncate().text_size(11.5).text_color(t.dim).child(tilde(c.path, this.userHome ?? "")));
    };
    const count = rows.length === all.length ? `${all.length} checkouts` : `${rows.length}/${all.length} checkouts`;
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().child(div().flex_1().font_semibold().text_color(t.foreground).child(`Open worktree${r ? ` of ${r.name}` : ""}`)).child(div().text_size(11).text_color(t.dim).child(r ? count : "")))
      .when(r === undefined || (r && this.list === undefined), (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder"} is not in a git repository.`)))
      .when(Boolean(r && this.list), (el) =>
        el
          .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(
                v_flex()
                  .id("wt-list")
                  .size_full()
                  .overflow_y_scroll()
                  .children(rows.map(row))
                  .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.dim).child("No matching worktrees."))),
              )
              .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
          ),
      )
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("\u2191\u2193 choose \u00b7 \u21b5 open \u00b7 esc close"));
  }

  render(cx) {
    const t = theme();
    if (this.opening) return this.renderOpen(t);
    const remove = props()?.action === "remove";
    const s = this.space();
    const r = this.repo;
    const title = remove ? `Remove worktree ${s?.name ?? ""}?` : `New worktree${r ? ` of ${r.name}` : ""}`;
    const detail =
      r === undefined
        ? "…"
        : r === null
          ? `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a git repository.`
          : remove
            ? !r.linked
              ? "This is the repository's main checkout, not a worktree."
              : `Closes the space and deletes ${tilde(r.top, this.userHome)}. The branch stays.`
            : this.created
              ? `Worktree created at ${tilde(this.created.path, this.userHome)}. Its files are kept even if setup fails.`
              : `A new worktree in ${tilde(ROOT(this.userHome), this.userHome)}/${r.name}/. An existing branch is checked out; a new branch starts from here.`;
    const blocked = !r || (remove && !r.linked) || (!remove && Boolean(this.defaultError || this.defaultSaving));
    const canSaveDefault = Boolean(r) && !this.busy && !this.defaultSaving && !this.defaultError && Boolean(this.script.value().trim());
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(title))
      .child(div().text_color(t.muted).child(detail))
      .when(remove && this.dirty, (el) => el.child(div().text_color(t.blocked).child("It has uncommitted changes: they will be lost.")))
      .when(remove && this.unpushed.length > 0, (el) => el.child(div().text_color(t.blocked).child(`Submodule ${this.unpushed.join(", ")} has commits that aren't pushed anywhere: they will be lost.`)))
      .when(!remove, el => el.child(v_flex().flex_none().gap(6)
        .child(div().text_size(12).text_color(t.muted).child("Branch"))
        .child(this.created || this.busy
          ? div().h(32).px(10).flex().items_center().text_color(t.foreground).child(this.created?.branch ?? this.text)
          : Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))))
      .when(!remove, el => el.child(v_flex().flex_none().gap(6)
        .child(div().text_size(12).text_color(t.muted).child("Bash setup script (optional)"))
        .child(this.busy || this.setupComplete
          ? div().h(108).p(10).rounded(6).bg(t.background).text_color(t.muted).child(this.busy ? this.stage : "Setup finished or was skipped. Opening this worktree will not run it again.")
          : Textarea.new(this.script).h(108).p(10).rounded(6).border(1).border_color(this.scriptFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
        .child(div().text_size(11).text_color(t.dim).child("Runs in the new checkout. Blank skips setup. Save explicitly to reuse for this repo."))
        .child(h_flex().h(26).flex_none().gap(12).items_center().text_size(11.5)
          .child(div().id("worktree-save-default").text_color(canSaveDefault ? t.accent : t.dim).tooltip(this.defaultsIO.path)
            .when(canSaveDefault, el => el.cursor_pointer().on_click((_e, cx) => cx.spawn(async cx => this.storeDefault(false, cx))))
            .child(this.defaultSaving ? "Saving…" : "Save repo default"))
          .when(this.savedScript !== null, el => el.child(div().id("worktree-remove-default").text_color(t.muted)
            .when(!this.busy && !this.defaultSaving && !this.defaultError, el => el.cursor_pointer().on_click((_e, cx) => cx.spawn(async cx => this.storeDefault(true, cx))))
            .child("Remove default")))
          .child(div().flex_1().truncate().text_color(this.defaultNotice.startsWith("Not saved:") ? t.blocked : t.dim).tooltip(this.defaultNotice || this.defaultsIO.path)
            .child(this.defaultNotice || (this.savedScript !== null ? this.script.value() === this.savedScript ? "Repo default loaded" : "One-off edits" : "No repo default"))))))
      .when(!remove && Boolean(this.defaultError), el => el.child(div().text_size(11.5).text_color(t.blocked).child(`Could not load repo default: ${this.defaultError}`)))
      .when(Boolean(this.error), el => el.child(div().id("worktree-error").h(86).flex_none().overflow_y_scrollbar().text_size(12).text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .when(!remove && Boolean(this.created) && !this.setupComplete && !this.busy, el => el.child(div().id("worktree-open-without-setup").text_size(12).text_color(t.accent).cursor_pointer().on_click((_e, cx) => this.openWithoutSetup(cx)).child("Open worktree without retrying setup")))
      .child(
        h_flex()
          .flex_none()
          .items_center()
          .justify_end()
          .text_size(11)
          .text_color(t.dim)
          .gap(6)
          .when(this.busy, (el) => el.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
          .child(this.busy ? this.stage || "working…" : blocked ? "esc close" : remove ? "↵ remove · esc cancel" : "Cmd/Ctrl+Enter · Esc cancel")
          .when(!remove && !this.busy, el => el.child(div().id("worktree-create").px(12).py(7).rounded(6).bg(blocked ? t.raised : t.selected).text_color(blocked ? t.dim : t.foreground)
            .when(!blocked, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.go(cx)))
            .child(this.setupComplete ? "Open worktree" : this.created ? "Retry setup" : "Create worktree"))),
      );
  }
}

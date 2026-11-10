// jump: tmux's prefix+w crossed with vimium. Every space and its tabs get a
// letter; type one and you're there. A space with one tab is a single row. A
// space's letter takes you to its active tab. j/k or arrows move, enter goes, x closes the selected tab, t opens a new
// tab, n a new space, esc bails. Pick your own letters in
// ~/.config/herdr-app/hints.json (see tiles.js).

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, agents, run, props, closeOverlay, shared, readTextFile, appHome, home } from "herdr";
import { colors, panelFill, hints, row, avatar, spaceName, spaceNote, glyph, navigate, spaceColor, hintLine, readHintConfig, ROW_H } from "./tiles.js";

/** @typedef {import("gpui-kit").Context} Context */
/** @typedef {import("gpui-kit").KeyEvent} KeyEvent */
/** @typedef {import("gpui-kit").FocusHandle} FocusHandle */
/** @typedef {import("herdr").SpaceInfo} SpaceInfo */
/** @typedef {import("herdr").TabInfo} TabInfo */
/** @typedef {import("./tiles.js").HintConfig} HintConfig */
/** @typedef {{ kind: "space", s: SpaceInfo, hint?: string, pinned?: boolean }} SpaceItem */
/** @typedef {{ kind: "tab", s: SpaceInfo, tab: TabInfo, who: string, status: string | null, merged: boolean, hint?: string, pinned?: boolean }} TabItem */
/** @typedef {{ kind: "new-tab" | "new-space", hint: string, pinned?: boolean }} NewItem */
/** @typedef {SpaceItem | TabItem | NewItem} Item */

// These do things, so they can't be hints.
const RESERVED = "tnqjkxr";

export default class Jump extends View {
  /** @param {unknown} _props @param {Context} cx */
  init(_props, cx) {
    /** @type {number | null} null until the first render lands on the active tab */
    this.at = null;
    /** @type {string} */
    this.typed = "";
    /** @type {{ it: SpaceItem | TabItem | NewItem, input: ReturnType<typeof InputState.new> } | null} */
    this.renaming = null;
    /** @type {HintConfig} */
    this.hintConfig = { spaces: {}, tabs: {} };
    cx.spawn(async (cx) => { this.hintConfig = await readHintConfig(readTextFile, appHome); cx.notify(); });
    /** @type {FocusHandle} */
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(600, () => this.handle.focus());
  }

  close() {
    closeOverlay(props().overlay);
  }

  /** Every hinted thing in order: a space's only tab as one row, else a header and its tabs, then the two new rows. @returns {Item[]} */
  items() {
    /** @type {Item[]} */
    const out = [];
    const ps = panes();
    const ag = agents();
    for (const s of spaces()) {
      const tabs = s.tabs ?? [];
      const merged = tabs.length === 1;
      if (!merged) out.push({ kind: "space", s });
      for (const tab of tabs) {
        const mine = ps.filter((p) => p.tab === tab.id);
        const who = mine.map((p) => p.mod ?? p.program?.name ?? "shell");
        const status = ag.filter((a) => a.tab === tab.id).map((a) => a.status);
        out.push({ kind: "tab", s, tab, who: [...new Set(who)].join(" · "), status: tab.status ?? status[0] ?? null, merged });
      }
    }
    const wanted = out.map((it) => (it.kind === "space" ? this.hintConfig.spaces[it.s.name] : it.kind === "tab" ? (it.merged && this.hintConfig.spaces[it.s.name]) || this.hintConfig.tabs[`${it.s.name}/${it.tab.name}`] : null));
    const hs = hints(out.length, RESERVED, wanted);
    out.forEach((it, i) => { it.hint = hs[i]; it.pinned = !!wanted[i] && hs[i] === String(wanted[i]).toLowerCase(); });
    out.push({ kind: "new-tab", hint: "t" });
    out.push({ kind: "new-space", hint: "n" });
    return out;
  }

  /** Goes where the item points, then closes. A new tab or space asks for its name first. @param {Item | undefined} it @param {Context} cx */
  go(it, cx) {
    if (!it) return;
    if (it.kind === "new-space" || it.kind === "new-tab") return this.startRename(it, cx);
    this.close();
    if (it.kind === "tab") run("tab.select", { id: it.tab.id });
    else if (it.kind === "space") run("space.select", { id: it.s.id });
  }

  /** Opens the name box for a tab or space, or empty for a new tab or space. @param {SpaceItem | TabItem | NewItem} it @param {Context} cx */
  startRename(it, cx) {
    const name = it.kind === "new-space" || it.kind === "new-tab" ? "" : it.kind === "tab" && !it.merged ? it.tab.name : it.s.name;
    const input = InputState.new({ value: name, placeholder: it.kind === "new-tab" ? "Tab name" : "Space name" });
    input.set_selected_range({ start: 0, end: name.length });
    input.on("submit", (_e, cx) => this.finishRename(true, cx));
    input.focus();
    this.renaming = { it, input };
    cx.notify();
  }

  /** Closes the name box, saving when asked. The popup stays open. @param {boolean} save @param {Context} cx */
  finishRename(save, cx) {
    if (!this.renaming) return;
    const { it, input } = this.renaming;
    this.renaming = null;
    if (it.kind === "new-space" || it.kind === "new-tab") {
      const name = input.value().trim();
      // Start in the home folder, not the current space's folder, so a new space shares nothing.
      if (save && name) { this.close(); if (it.kind === "new-tab") run("tab.new", { name }); else run("space.new", { folder: home(), name }); return; }
    } else if (save) {
      if (it.kind === "tab" && !it.merged) run("tab.rename", { id: it.tab.id, name: input.value() });
      else run("space.rename", { id: it.s.id, name: input.value() });
    }
    this.handle.focus();
    cx.notify();
  }

  /** @param {KeyEvent} e @param {Context} cx */
  key(e, cx) {
    // While the name box is open, every key but Esc belongs to it.
    if (this.renaming) {
      if (e.key === "escape") { this.finishRename(false, cx); cx.stop_propagation(); }
      return;
    }
    const items = this.items();
    /** @type {import("./tiles.js").NavState} */
    const state = { at: this.at ?? 0, typed: this.typed };
    const r = navigate(state, e, items);
    this.at = state.at;
    this.typed = state.typed;
    if (r === "close") { this.close(); cx.stop_propagation(); return; }
    if (r === "hit" || r === "act") this.go(items[this.at], cx);
    if (r) { cx.stop_propagation(); cx.notify(); return; }
    const it = items[this.at];
    if (e.keystroke === "x" && it?.kind === "tab") {
      // Stay open: the row drops out when the live data changes. Closing the active tab can move focus, so take it back.
      run("tab.close", { id: it.tab.id, confirmed: true });
      cx.timer.after(150, () => this.handle.focus());
    } else if (e.keystroke === "r" && (it?.kind === "tab" || it?.kind === "space")) this.startRename(it, cx);
    else if (e.keystroke === "q") this.close();
    else return;
    cx.stop_propagation();
  }

  /** @param {Context} cx */
  render(cx) {
    const t = colors();
    const items = this.items();
    // Start on the tab you're already in.
    if (this.at === null) this.at = Math.max(0, items.findIndex((it) => it.kind === "tab" && it.s.active && it.tab.active));
    this.at = Math.max(0, Math.min(this.at, items.length - 1));
    const at = this.at;
    const space = /** @type {Record<string, string> | undefined} */ (shared("space.colors"));
    const all = spaces();
    // gpui elements are single-use, so collect each block's rows first and build it after.
    /** @type {{ merged: boolean, rows: ReturnType<typeof row>[] }[]} */
    const blocks = [];
    /** @type {ReturnType<typeof row>[]} */
    const extras = [];
    items.forEach((it, i) => {
      const on = i === at;
      if (it.kind === "space") {
        blocks.push({ merged: false, rows: [
          row(t, { id: `j-${it.s.id}`, hint: it.hint ?? "", typed: this.typed, pinned: it.pinned, on, onClick: (_e, cx) => this.go(it, cx) }).child(avatar(it.s, spaceColor(t, it.s, space))).child(spaceName(t, it.s)).child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(spaceNote(all, it.s, home()))),
        ] });
      } else if (it.kind === "tab" && it.merged) {
        if (!blocks[blocks.length - 1]?.merged) blocks.push({ merged: true, rows: [] });
        blocks[blocks.length - 1].rows.push(
          row(t, { id: `j-${it.tab.id}`, hint: it.hint ?? "", typed: this.typed, pinned: it.pinned, on, onClick: (_e, cx) => this.go(it, cx) })
            .child(avatar(it.s, spaceColor(t, it.s, space)))
            .child(spaceName(t, it.s))
            .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(spaceNote(all, it.s, home())))
            .when(!!it.status, (el) => el.child(glyph(t, it.status)))
            .child(div().flex_none().max_w(180).truncate().text_size(11).text_color(t.dim).child([it.tab.named ? it.tab.name : "", it.who || "empty"].filter(Boolean).join(" · "))),
        );
      } else if (it.kind === "tab") {
        blocks[blocks.length - 1].rows.push(
          row(t, { id: `j-${it.tab.id}`, hint: it.hint ?? "", typed: this.typed, pinned: it.pinned, on, onClick: (_e, cx) => this.go(it, cx) })
            .child(div().w(18).flex_none())
            .when(!!it.status, (el) => el.child(glyph(t, it.status)))
            .child(div().flex_none().max_w(260).truncate().text_color(t.muted).child(it.tab.name))
            .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(it.who || "empty")),
        );
      } else {
        extras.push(
          row(t, { id: `j-${it.kind}`, hint: it.hint, typed: this.typed, pinned: false, on, onClick: (_e, cx) => this.go(it, cx) })
            .child(div().flex_none().text_color(t.foreground).child(it.kind === "new-tab" ? "new tab" : "new space"))
            .child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(it.kind === "new-tab" ? "in this space" : "on this computer")),
        );
      }
    });
    const rowCount = blocks.reduce((n, b) => n + b.rows.length, 0);
    const sections = blocks.map((b) => v_flex().gap(2).children(b.rows));
    sections.push(v_flex().gap(2).pt(8).border_t(1).border_color(t.border).children(extras));
    // The popup sizes to content, so the scrollable list needs an explicit height or it collapses.
    const est = (rowCount + 2) * (ROW_H + 2) + blocks.length * 8 + 16;
    const listH = Math.min(560, est);

    return v_flex()
      .id("jump")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(panelFill(t, 1, 0.1, t.popover)) // the dialogs' popover color at the islands panel opacity, a bit more solid
      .rounded(14).overflow_hidden().border_1().border_color(t.border) // our own frame (mod.json says frame: none); no shadow, Herdr clips it
      .text_size(13)
      .child(
        h_flex().items_center().gap(10)
          .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Jump to…"))
          .child(div().pr(10).text_size(11).text_color(t.dim).child("Esc")),
      )
      .when(!!this.renaming, (el) => el.child(
        h_flex().items_center().gap(10)
          .child(div().flex_none().text_size(11).text_color(t.dim).child(this.renaming?.it.kind === "new-space" ? "New space" : this.renaming?.it.kind === "new-tab" ? "New tab" : this.renaming?.it.kind === "tab" && !this.renaming.it.merged ? "Rename tab" : "Rename space"))
          .child(Input.new(this.renaming?.input).flex_1().h(30).px(8).rounded(6).border_1().border_color(t.accent).bg(t.background).text_size(12.5).text_color(t.foreground)),
      ))
      .child(v_flex().id("jump-list").h(listH).flex_none().overflow_y_scrollbar().gap(8).children(sections))
      .child(hintLine(t, [["j/k", "move"], ["x", "close tab"], ["r", "rename"]]));
  }
}

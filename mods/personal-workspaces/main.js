import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, agents, panes, machines, focused, theme, run, window, keys, shared, setShared, exec, notify, nextCommand, props, layout, openOverlay } from "herdr";
import { WorkspaceLifecycle, CLOSED, REQUESTS } from "./lifecycle.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const match = find(child, id); if (match) return match; }
  return null;
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    if (props()?.empty) {
      this.emptyHandle = cx.focus_handle();
      this.emptyHandle.focus();
      return;
    }
    this.life = new WorkspaceLifecycle({ spaces, agents, panes, machines, shared, setShared, exec, notify, run, now: () => Date.now() });
    cx.spawn(async cx => { await this.life.sweep(); cx.notify(); });
    cx.timer.every(30000, cx => cx.spawn(async cx => { await this.life.sweep(); cx.notify(); }));
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        this.command(command, cx);
        cx.notify();
      }
    });
  }

  visible() {
    const closed = shared(CLOSED) ?? {};
    const order = shared("personal.workspaces.order") ?? [];
    return spaces().filter(space => !closed[space.id]).sort((a, b) => {
      const index = id => order.includes(id) ? order.indexOf(id) : order.length;
      return index(a.id) - index(b.id);
    });
  }

  closeTab(id, cx) {
    const space = spaces().find(space => space.tabs.some(tab => tab.id === id));
    if (!space || shared(CLOSED)?.[space.id]) return;
    if (space.tabs.length === 1) cx.spawn(async cx => { await this.life.close(space.id); cx.notify(); });
    else run("tab.close", { id });
  }

  closePane(id, cx) {
    const pane = panes().find(pane => pane.pane === id);
    const space = pane && spaces().find(space => space.tabs.some(tab => tab.id === pane.tab));
    if (!space || shared(CLOSED)?.[space.id]) return;
    if (space.tabs.length === 1 && panes().filter(p => p.tab === pane.tab).length === 1) this.closeTab(pane.tab, cx);
    else run("pane.close", { pane: id });
  }

  command(command, cx) {
    if (command === "sweep") return cx.spawn(async cx => { await this.life.sweep(); cx.notify(); });
    const current = focused();
    const visible = this.visible();
    if (command === "new-worktree") {
      const space = visible.find(space => space.id === current?.space) ?? visible.find(space => space.active);
      if (!space) return notify({ title: "Select an open space first", body: "Select a Git space to create a worktree beneath it.", level: "info" });
      return openOverlay({ mod: "personal-worktree", kind: "dialog", modal: true, width: 600, height: 560, props: { space: space.id, action: "new" } });
    }
    if (command === "close-tab") return this.closeTab(current?.tab, cx);
    if (command === "close-pane") return this.closePane(current?.pane, cx);
    if (command === "new-tab") return run(current && !shared(CLOSED)?.[current.space] ? "tab.new" : "space.new");
    if (command.startsWith("active-")) {
      if (!current || shared(CLOSED)?.[current.space]) return;
      const action = command.slice(7);
      const tabIndex = /^tab-select-([1-9])$/.exec(action);
      if (tabIndex) return run("tab.select", { index: Number(tabIndex[1]) });
      const directions = /^(pane-go|pane-swap|split)-(left|right|up|down)$/.exec(action);
      if (directions) return run(directions[1] === "split" ? "pane.split" : directions[1] === "pane-go" ? "pane.go" : "pane.swap", { direction: directions[2] });
      const commands = { "tab-next": "tab.next", "tab-prev": "tab.prev", "zoom": "pane.zoom", "tab-rename": "tab.rename", "space-rename": "space.rename" };
      if (commands[action]) run(commands[action]);
      return;
    }
    if (command.startsWith("space-select-")) {
      const space = visible[Number(command.slice(13)) - 1];
      if (space) run("space.select", { id: space.id });
    } else if (command === "space-next" || command === "space-prev") {
      if (!visible.length) return;
      const at = visible.findIndex(space => space.active);
      const next = at < 0 ? 0 : (at + (command === "space-next" ? 1 : visible.length - 1)) % visible.length;
      run("space.select", { id: visible[next].id });
    } else if (command === "agent-next" || command === "agent-prev") {
      const all = agents().filter(agent => !shared(CLOSED)?.[agent.space]);
      const order = shared("personal.workspaces.agent-order") ?? [];
      const list = all.sort((a, b) => order.indexOf(a.address) - order.indexOf(b.address));
      if (!list.length) return;
      const at = list.findIndex(agent => agent.focused);
      const next = at < 0 ? 0 : (at + (command === "agent-next" ? 1 : list.length - 1)) % list.length;
      run("agent.focus", { terminal: list[next].address });
    }
  }

  sync(cx) {
    const requests = shared(REQUESTS) ?? [];
    if (requests.length) {
      setShared(REQUESTS, []);
      for (const request of requests) {
        if (request.action === "close") cx.spawn(async cx => { await this.life.close(request.id); cx.notify(); });
        else if (request.action === "reopen") this.life.reopen(request.id);
        else if (request.action === "close-tab") this.closeTab(request.id, cx);
        else if (request.action === "close-pane") this.closePane(request.id, cx);
      }
    }
    const visible = this.visible();
    const active = spaces().find(space => space.active);
    if (active && shared(CLOSED)?.[active.id] && visible.length) run("space.select", { id: visible[0].id });
    const target = !visible.length || (active && shared(CLOSED)?.[active.id]) ? "workspace-empty" : "work-body";
    if (find(layout(), "workspace-content")?.active !== target) {
      if (target === "workspace-empty") setShared("personal.workspaces.empty-activation", (shared("personal.workspaces.empty-activation") ?? 0) + 1);
      run("layout.select", { stack: "workspace-content", child: target });
    }
  }
  // The palette key as actually bound, not a hardcoded one; without a
  // binding the hint stays useful ("commands") instead of lying.
  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render(cx) {
    const t = theme();
    if (props()?.empty) {
      const activation = shared("personal.workspaces.empty-activation");
      if (activation !== this.emptyActivation) { this.emptyActivation = activation; this.emptyHandle.focus(); }
      return v_flex().size_full().track_focus(this.emptyHandle)
      .on_key_down((event, cx) => { if (!event.modifiers.platform && !event.modifiers.control && !event.modifiers.alt) cx.stop_propagation(); })
      .gap(12).items_center().justify_center().text_color(t.muted)
      .child(div().text_size(18).child("No open worktree"))
      .child(div().text_size(13).child("Reopen a recently closed worktree in Spaces, or start a new space."))
      .child(div().id("workspace-start").px(16).py(9).rounded(7).bg(t.selected).text_color(t.foreground).cursor_pointer().on_click(() => run("space.new")).child("New space"));
    }
    this.sync(cx);
    const space = spaces().find(s => s.active && !shared(CLOSED)?.[s.id]);
    const list = agents().filter(agent => !shared(CLOSED)?.[agent.space]);
    const needs = list.filter(a => a.status === "blocked").length;
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);
    return h_flex().size_full().px(14).gap(16).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), el => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} agents`)
        .when(needs > 0, el => el.child(div().text_color(t.blocked).child(`· ${needs} needs you`))))
      .child(div().flex_1())
      .child(div().id("palette").text_color(t.dim).on_click(() => run("app.palette")).child(this.hint(t)));
  }
}

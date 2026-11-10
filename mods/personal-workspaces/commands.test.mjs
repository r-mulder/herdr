import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import { CLOSED } from "./lifecycle.js";

// Test the real command boundary without loading GPUI or touching live sessions.
const source = (await readFile(new URL("./main.js", import.meta.url), "utf8"))
  .replace(/^import .*;$/gm, "")
  .replace("export default class WorkspaceStatus", "class WorkspaceStatus") + "\nWorkspaceStatus;";

function controller({ spaces = [], focused = null, closed = {} } = {}) {
  const overlays = [], notices = [];
  const Controller = vm.runInNewContext(source, {
    View: class {}, CLOSED,
    spaces: () => spaces, focused: () => focused,
    shared: key => key === CLOSED ? closed : undefined,
    openOverlay: spec => overlays.push(spec), notify: notice => notices.push(notice),
  });
  return { instance: new Controller(), overlays, notices };
}

test("new-worktree opens the existing creation dialog for the current space", () => {
  const c = controller({ spaces: [{ id: "parent", active: true }], focused: { space: "parent" } });
  c.instance.command("new-worktree", {});
  assert.equal(c.overlays.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(c.overlays[0])), {
    mod: "personal-worktree", kind: "dialog", modal: true, width: 600, height: 560,
    props: { space: "parent", action: "new" },
  });
});

test("new-worktree can use the active space while focus is outside a terminal", () => {
  const c = controller({ spaces: [{ id: "parent", active: true }] });
  c.instance.command("new-worktree", {});
  assert.equal(c.overlays[0].props.space, "parent");
});

test("new-worktree does not create work inside an archived space", () => {
  const c = controller({ spaces: [{ id: "closed", active: true }], focused: { space: "closed" }, closed: { closed: {} } });
  c.instance.command("new-worktree", {});
  assert.equal(c.overlays.length, 0);
  assert.equal(c.notices.length, 1);
});

test("new-worktree does not pick an unrelated space when none is selected", () => {
  const c = controller({ spaces: [{ id: "other", active: false }] });
  c.instance.command("new-worktree", {});
  assert.equal(c.overlays.length, 0);
  assert.equal(c.notices.length, 1);
});

test("Cmd+Shift+N adds a layout-only shortcut without taking an existing binding", async () => {
  const keys = JSON.parse(await readFile(new URL("../../keys.json", import.meta.url), "utf8"));
  assert.equal(keys["layout:personal-workspace"]["cmd-shift-n"], "personal-workspaces.new-worktree");
  assert.equal(keys.global["cmd-shift-n"], undefined);
  assert.equal(keys.terminal["cmd-shift-n"], undefined);
  assert.equal(keys.global["cmd-n"], "space.new");
});

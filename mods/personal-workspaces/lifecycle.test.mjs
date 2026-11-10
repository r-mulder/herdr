import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceLifecycle, CLOSED, RETENTION, snapshot, removeSafely, worktrees } from "./lifecycle.js";

const execute = promisify(execFile);
const TEMP = process.env.HERDR_TEST_TMPDIR ?? join(tmpdir(), "opencode");
await mkdir(TEMP, { recursive: true });
const git = async (cwd, args) => (await execute("git", args, { cwd, encoding: "utf8" })).stdout;

function host() {
  const state = { now: 1000, data: {}, commands: [], notices: [], gitCalls: [], ready: true };
  state.spaces = [{ id: "space", name: "Feature", named: true, machine: null, folder: "/main", tabs: [{ id: "tab" }] }];
  const api = {
    spaces: () => state.spaces, panes: () => [], machines: () => [{ name: null, layout: state.ready ? "ready" : "unavailable" }],
    shared: key => state.data[key], setShared: (key, value) => { state.data[key] = value; }, now: () => state.now,
    run: (command, args) => { state.commands.push({ command, args }); }, notify: notice => state.notices.push(notice),
    exec: async (_program, args, options) => {
      state.gitCalls.push({ args, options });
      const stdout = args.includes("--show-toplevel") ? "/main\n" : args.includes("--git-common-dir") ? "/main/.git\n" : args[0] === "worktree" && args[1] === "list" ? "worktree /main\0HEAD 123\0branch refs/heads/main\0\0" : "";
      return { code: 0, stdout, stderr: "" };
    },
  };
  return { state, api, lifecycle: new WorkspaceLifecycle(api) };
}

test("soft close retains the original space and does not end or restart terminals", async () => {
  const { state, lifecycle } = host();
  await lifecycle.close("space");
  assert.equal(state.spaces[0].id, "space");
  assert.deepEqual(state.commands, []);
  assert.equal(state.data[CLOSED].space.expiresAt, 1000 + RETENTION);
});

test("reopen selects the same space and cancels retention; a later close gets a fresh timer", async () => {
  const { state, lifecycle } = host();
  await lifecycle.close("space");
  state.now += 500;
  lifecycle.reopen("space");
  assert.deepEqual(state.data[CLOSED], {});
  assert.deepEqual(state.commands, [{ command: "space.select", args: { id: "space" } }]);
  await lifecycle.close("space");
  assert.equal(state.data[CLOSED].space.expiresAt, state.now + RETENTION);
});

test("reopen while offline preserves the record", async () => {
  const { state, lifecycle } = host();
  await lifecycle.close("space");
  state.ready = false;
  lifecycle.reopen("space");
  assert.ok(state.data[CLOSED].space);
  assert.equal(state.commands.length, 0);
});

test("a failed reopen preserves the record", async () => {
  const { state, api, lifecycle } = host();
  await lifecycle.close("space");
  api.run = () => { throw new Error("disconnected"); };
  lifecycle.reopen("space");
  assert.ok(state.data[CLOSED].space);
});

test("expiry is exactly four days and file cleanup waits for confirmed core removal", async () => {
  const { state, lifecycle } = host();
  await lifecycle.close("space");
  state.now += RETENTION - 1;
  await lifecycle.sweep();
  assert.equal(state.commands.length, 0);
  state.now++;
  await lifecycle.sweep();
  assert.deepEqual(state.commands, [{ command: "space.close", args: { id: "space", confirmed: true } }]);
  assert.equal(state.data[CLOSED].space.phase, "closing");
  assert.ok(!state.gitCalls.some(call => call.args.includes("remove")));
  await lifecycle.sweep();
  assert.equal(state.commands.length, 1);
  state.spaces = [];
  await lifecycle.sweep();
  assert.deepEqual(state.data[CLOSED], {});
  assert.ok(!state.gitCalls.some(call => call.args.includes("remove")), "main checkout must never be deleted");
});

test("overdue cleanup waits for an unavailable machine and resumes later", async () => {
  const { state, api, lifecycle } = host();
  await lifecycle.close("space");
  state.now += RETENTION;
  state.ready = false;
  await lifecycle.sweep();
  assert.equal(state.commands.length, 0);
  state.ready = true;
  await new WorkspaceLifecycle(api).sweep();
  assert.equal(state.commands[0].command, "space.close");
});

test("reopening before expiry prevents future cleanup", async () => {
  const { state, lifecycle } = host();
  await lifecycle.close("space");
  lifecycle.reopen("space");
  state.now += RETENTION * 2;
  await lifecycle.sweep();
  assert.ok(!state.commands.some(call => call.command === "space.close"));
});

test("tabs added outside the custom UI defer expiry instead of killing new work", async () => {
  const { state, lifecycle } = host();
  await lifecycle.close("space");
  state.spaces[0].tabs.push({ id: "new-tab" });
  state.now += RETENTION;
  await lifecycle.sweep();
  assert.equal(state.commands.length, 0);
  assert.match(state.data[CLOSED].space.reason, /tabs or panes changed/);
});

test("panes added to an existing closed tab also defer cleanup", async () => {
  const { state, api, lifecycle } = host();
  await lifecycle.close("space");
  api.panes = () => [{ pane: "new-pane", tab: "tab", cwd: "/main" }];
  state.now += RETENTION;
  await lifecycle.sweep();
  assert.equal(state.commands.length, 0);
  assert.match(state.data[CLOSED].space.reason, /panes changed/);
});

test("an original terminal exiting while archived does not prevent expiry", async () => {
  const { state, api, lifecycle } = host();
  state.spaces[0].tabs.push({ id: "second-tab" });
  api.panes = () => [{ pane: "first", tab: "tab", cwd: "/main" }, { pane: "second", tab: "second-tab", cwd: "/main" }];
  await lifecycle.close("space");
  state.spaces[0].tabs = [{ id: "second-tab" }];
  api.panes = () => [{ pane: "second", tab: "second-tab", cwd: "/main" }];
  state.now += RETENTION;
  await lifecycle.sweep();
  assert.equal(state.commands[0].command, "space.close");
});

test("a snapshot finishing after reopening cannot resurrect an archive", async () => {
  const { state, api, lifecycle } = host();
  const original = api.exec;
  let release;
  api.exec = async (...args) => { if (!release) await new Promise(resolve => { release = resolve; }); return original(...args); };
  const closing = lifecycle.close("space");
  lifecycle.reopen("space");
  release();
  await closing;
  assert.deepEqual(state.data[CLOSED], {});
});

test("a failed native close remains recoverable and never deletes files", async () => {
  const { state, api, lifecycle } = host();
  await lifecycle.close("space");
  state.now += RETENTION;
  api.run = () => { throw new Error("core unavailable"); };
  await lifecycle.sweep();
  assert.equal(state.data[CLOSED].space.phase, "closed");
  assert.match(state.data[CLOSED].space.reason, /core unavailable/);
  assert.ok(!state.gitCalls.some(call => call.args.includes("remove")));
});

test("reopen cannot race an already issued terminal-ending cleanup", async () => {
  const { state, lifecycle } = host();
  await lifecycle.close("space");
  state.now += RETENTION;
  await lifecycle.sweep();
  lifecycle.reopen("space");
  assert.ok(state.data[CLOSED].space);
  assert.ok(!state.commands.some(call => call.command === "space.select"));
});

test("NUL porcelain parsing preserves spaces, Unicode and trailing whitespace in paths", () => {
  assert.deepEqual(worktrees("worktree /main\0HEAD abc\0\0worktree /a '海' \0locked reason\0\0"), [
    { path: "/main", locked: false, bare: false }, { path: "/a '海' ", locked: true, bare: false },
  ]);
});

async function fixture(t) {
  const root = await mkdtemp(`${TEMP}/herdr-lifecycle-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = `${root}/repo`, checkout = `${root}/feature '海' `;
  await mkdir(main);
  await git(main, ["init", "--initial-branch=main"]);
  await git(main, ["config", "user.name", "Herdr test"]);
  await git(main, ["config", "user.email", "herdr-test@example.invalid"]);
  await writeFile(`${main}/file.txt`, "original\n");
  await writeFile(`${main}/.gitignore`, "ignored.txt\n");
  await git(main, ["add", "."]);
  await git(main, ["commit", "-m", "test fixture"]);
  await git(main, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(main, ["worktree", "add", "-b", "feature", checkout]);
  const saved = await snapshot(checkout, null, git);
  return { root, main, checkout, saved };
}

test("a clean pushed worktree is removed without deleting its branch or main checkout", async t => {
  const f = await fixture(t);
  await removeSafely(f.saved, null, git, () => false, () => true);
  await assert.rejects(access(f.checkout));
  await access(f.main);
  await git(f.main, ["show-ref", "--verify", "refs/heads/feature"]);
});

for (const kind of ["dirty", "untracked", "ignored", "unpushed", "locked", "shared", "cancelled", "identity", "submodule"]) {
  test(`cleanup preserves a ${kind} checkout`, async t => {
    const f = await fixture(t);
    if (kind === "dirty") await writeFile(`${f.checkout}/file.txt`, "changed\n");
    if (kind === "untracked") await writeFile(`${f.checkout}/notes.txt`, "precious\n");
    if (kind === "ignored") await writeFile(`${f.checkout}/ignored.txt`, "precious\n");
    if (kind === "unpushed") {
      await writeFile(`${f.checkout}/file.txt`, "unpushed\n");
      await git(f.checkout, ["commit", "-am", "local-only"]);
    }
    if (kind === "locked") await git(f.main, ["worktree", "lock", f.checkout]);
    if (kind === "identity") f.saved.common = "/not-the-same-repository/.git";
    if (kind === "submodule") {
      const head = (await git(f.checkout, ["rev-parse", "HEAD"])).trim();
      await git(f.checkout, ["update-index", "--add", "--cacheinfo", `160000,${head},sub`]);
      await git(f.checkout, ["commit", "-m", "gitlink"]);
      await git(f.checkout, ["update-ref", "refs/remotes/origin/feature", "HEAD"]);
    }
    await assert.rejects(removeSafely(f.saved, null, git, () => kind === "shared", () => kind !== "cancelled"));
    await access(f.checkout);
    if (kind === "untracked") await access(`${f.checkout}/notes.txt`);
    if (kind === "ignored") await access(`${f.checkout}/ignored.txt`);
  });
}

test("a reopened record detected during async Git checks cancels deletion", async t => {
  const f = await fixture(t);
  let live = true;
  const interruptedGit = async (...args) => { const result = await git(...args); live = false; return result; };
  await assert.rejects(removeSafely(f.saved, null, interruptedGit, () => false, () => live), /cancelled/);
  await access(f.checkout);
});

test("unsafe worktree files survive expiry while the expired archive entry is cleared", async t => {
  const f = await fixture(t);
  await writeFile(`${f.checkout}/notes.txt`, "keep this local work\n");
  const { state, api, lifecycle } = host();
  state.spaces[0].folder = f.checkout;
  api.exec = async (command, args, options) => {
    try { return { code: 0, ...(await execute(command, args, { cwd: options.cwd, encoding: "utf8" })) }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  await lifecycle.close("space");
  state.now += RETENTION;
  await lifecycle.sweep();
  state.spaces = [];
  await lifecycle.sweep();
  assert.deepEqual(state.data[CLOSED], {});
  await access(`${f.checkout}/notes.txt`);
  assert.match(state.notices[0].body, /Files kept/);
});

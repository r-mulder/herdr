import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm, access, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import vm from "node:vm";
import { test } from "node:test";

const execute = promisify(execFile);
const source = (await readFile(new URL("./main.js", import.meta.url), "utf8"))
  .replace(/^import .*;$/gm, "")
  .replace("export default class Worktree", "class Worktree") + "\nWorktree;";

function dialog({ script = "", on = null, branch = "feature/test", executor, existingBranch = false } = {}) {
  const state = { script, calls: [], opens: [], parents: [], closed: [], gitError: null, bashError: null };
  const Worktree = vm.runInNewContext(source, {
    View: class {},
    exec: async (command, args, options) => {
      const call = JSON.parse(JSON.stringify({ command, args, options }));
      state.calls.push(call);
      if (executor) return executor(command, args, options);
      if (command === "git" && args[0] === "show-ref") return { code: existingBranch ? 0 : 1, stdout: "", stderr: "" };
      if (command === "git" && state.gitError) return { code: 1, stdout: "", stderr: state.gitError };
      if (command === "bash" && state.bashError) return state.bashError;
      return { code: 0, stdout: "", stderr: "" };
    },
    props: () => ({ action: "new", overlay: "test-dialog", tab: "first tab" }),
    run: (command, args) => {
      if (state.openError) throw new Error(state.openError);
      state.opens.push(JSON.parse(JSON.stringify({ command, args })));
    },
    closeOverlay: id => state.closed.push(id),
  });
  const view = new Worktree();
  Object.assign(view, {
    text: branch, script: { value: () => state.script }, on,
    repo: { main: "/repo", top: "/repo", name: "repo" }, userHome: "/home/test",
    created: null, setupComplete: false, opened: false, busy: false, error: "",
    rememberParent: path => state.parents.push(path),
  });
  return { view, state, cx: { notify() {}, stop_propagation() {} } };
}

test("blank setup keeps the original create behavior and never starts Bash", async () => {
  const d = dialog({ script: " \n  " });
  assert.equal(await d.view.create(d.cx), "");
  assert.ok(d.state.calls.every(call => call.command === "git"));
  assert.equal(d.state.opens.length, 1);
  assert.equal(d.state.opens[0].args.folder, "/home/test/.herdr/worktrees/repo/feature-test");
});

test("setup runs after Git creation, in the new checkout on its machine, before opening", async () => {
  const script = "printf '%s\\n' \"$PWD\"\nbash './a script.sh'";
  const d = dialog({ script, on: "build-machine" });
  assert.equal(await d.view.create(d.cx), "");
  assert.deepEqual(d.state.calls.map(call => call.command), ["git", "git", "bash"]);
  const setup = d.state.calls[2];
  assert.deepEqual(setup.args, ["-e", "-o", "pipefail", "-c", script, "herdr-worktree-setup"]);
  assert.equal(setup.options.cwd, d.view.created.path);
  assert.equal(setup.options.on, "build-machine");
  assert.equal(setup.options.timeout, 600000);
  assert.equal(d.state.opens[0].command, "space.new");
});

test("Git failure never runs setup or opens a terminal", async () => {
  const d = dialog({ script: "touch marker" });
  d.state.gitError = "branch is already checked out";
  assert.match(await d.view.create(d.cx), /already checked out/);
  assert.equal(d.view.created, null);
  assert.ok(!d.state.calls.some(call => call.command === "bash"));
  assert.equal(d.state.opens.length, 0);
});

test("existing branches are checked out without creating a second branch", async () => {
  const d = dialog({ existingBranch: true });
  await d.view.create(d.cx);
  assert.deepEqual(d.state.calls[1].args, ["worktree", "add", d.view.created.path, "feature/test"]);
});

test("setup failure preserves the created checkout and reports output without opening it", async () => {
  const d = dialog({ script: "false" });
  d.state.bashError = { code: 7, stdout: "partial output", stderr: "setup failed" };
  const error = await d.view.create(d.cx);
  assert.match(error, /exit 7/);
  assert.match(error, /partial output/);
  assert.match(error, /setup failed/);
  assert.ok(d.view.created.path);
  assert.equal(d.view.setupComplete, false);
  assert.equal(d.state.opens.length, 0);
  assert.ok(!d.state.calls.some(call => call.args.includes("remove")));
});

test("explicit setup retry reuses the checkout instead of rerunning git worktree add", async () => {
  const d = dialog({ script: "false" });
  d.state.bashError = { code: 1, stdout: "", stderr: "failed" };
  await d.view.create(d.cx);
  d.state.script = "printf retried";
  d.state.bashError = null;
  assert.equal(await d.view.create(d.cx), "");
  assert.equal(d.state.calls.filter(call => call.command === "git" && call.args[0] === "worktree").length, 1);
  assert.equal(d.state.calls.filter(call => call.command === "bash").length, 2);
  assert.equal(d.state.opens.length, 1);
});

test("open without retrying setup does not run the script a second time", async () => {
  const d = dialog({ script: "false" });
  d.state.bashError = { code: 1, stdout: "", stderr: "failed" };
  await d.view.create(d.cx);
  d.view.openWithoutSetup(d.cx);
  assert.equal(d.state.calls.filter(call => call.command === "bash").length, 1);
  assert.equal(d.state.opens.length, 1);
  assert.deepEqual(d.state.closed, ["test-dialog"]);
});

test("missing Bash or timeout preserves the checkout with a useful error", async () => {
  const d = dialog({ script: "echo hello", executor: async command => {
    if (command === "bash") throw new Error("Bash was not found or timed out");
    return { code: 0, stdout: "", stderr: "" };
  } });
  assert.match(await d.view.create(d.cx), /Bash was not found or timed out/);
  assert.ok(d.view.created);
  assert.equal(d.state.opens.length, 0);
});

test("repeated successful submission neither reruns setup nor opens duplicate worktrees", async () => {
  const d = dialog({ script: "echo hello" });
  await d.view.create(d.cx);
  await d.view.create(d.cx);
  assert.equal(d.state.calls.filter(call => call.command === "bash").length, 1);
  assert.equal(d.state.opens.length, 1);
});

test("retrying a failed terminal open does not rerun successful setup", async () => {
  const d = dialog({ script: "echo hello" });
  d.state.openError = "core unavailable";
  await d.view.work(d.cx);
  assert.match(d.view.error, /core unavailable/);
  assert.equal(d.view.setupComplete, true);
  d.state.openError = null;
  await d.view.work(d.cx);
  assert.equal(d.state.calls.filter(call => call.command === "bash").length, 1);
  assert.equal(d.state.opens.length, 1);
});

test("failure output is bounded rather than overflowing the dialog with a large log", async () => {
  const d = dialog({ script: "false" });
  d.state.bashError = { code: 1, stdout: "x".repeat(50000), stderr: "last useful error" };
  const error = await d.view.create(d.cx);
  assert.ok(error.length < 3300);
  assert.match(error, /last useful error/);
});

test("invalid empty branch does not execute setup", async () => {
  const d = dialog({ branch: "   ", script: "echo hello" });
  assert.match(await d.view.create(d.cx), /branch name/);
  assert.equal(d.state.calls.length, 0);
});

test("busy create ignores duplicate submissions and prevents its own Escape handler closing", async () => {
  const d = dialog({ script: "echo hello" });
  await Promise.all([d.view.work(d.cx), d.view.work(d.cx)]);
  assert.equal(d.state.calls.filter(call => call.command === "bash").length, 1);
  d.state.closed.length = 0;
  d.view.busy = true;
  d.view.key({ key: "escape" }, d.cx);
  assert.equal(d.state.closed.length, 0);
});

async function fixture(t) {
  const temp = process.env.HERDR_TEST_TMPDIR ?? join(tmpdir(), "opencode");
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, "herdr-bash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), home = join(root, "home");
  await mkdir(repo);
  await mkdir(home);
  const git = args => execute("git", args, { cwd: repo });
  await git(["init", "--initial-branch=main"]);
  await git(["config", "user.name", "Herdr Bash test"]);
  await git(["config", "user.email", "herdr-bash-test@example.invalid"]);
  await writeFile(join(repo, "setup.sh"), "printf 'script ran' > setup-result.txt\n");
  await git(["add", "."]);
  await git(["commit", "-m", "Disposable setup fixture"]);
  const d = dialog({ executor: async (command, args, options) => {
    try { return { code: 0, ...(await execute(command, args, { cwd: options.cwd, encoding: "utf8" })) }; }
    catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  } });
  d.view.repo = { main: repo, top: repo, name: "repo" };
  d.view.userHome = home;
  return d;
}

test("real Bash can run a relative script file inside a freshly created Git worktree", async t => {
  const d = await fixture(t);
  d.state.script = "printf '%s\\n' \"$PWD\" > setup-cwd.txt\nbash ./setup.sh";
  assert.equal(await d.view.create(d.cx), "");
  assert.equal(await readFile(join(d.view.created.path, "setup-result.txt"), "utf8"), "script ran");
  assert.equal(await realpath((await readFile(join(d.view.created.path, "setup-cwd.txt"), "utf8")).trim()), await realpath(d.view.created.path));
  assert.equal(d.state.opens.length, 1);
});

test("Bash setup and terminal opening work when the worktree root is a symlink", async t => {
  const d = await fixture(t);
  const physical = join(d.view.userHome, "physical-checkouts");
  await mkdir(physical);
  await mkdir(join(d.view.userHome, ".herdr"));
  await symlink(physical, join(d.view.userHome, ".herdr", "worktrees"));
  d.state.script = "printf '%s\\n' \"$PWD\" > setup-cwd.txt";
  assert.equal(await d.view.create(d.cx), "");
  const actual = (await readFile(join(d.view.created.path, "setup-cwd.txt"), "utf8")).trim();
  assert.equal(await realpath(actual), await realpath(d.view.created.path));
  assert.equal(d.state.opens[0].args.folder, d.view.created.path);
});

test("real failing setup stops at failure, keeps partial work, and can retry in the same checkout", async t => {
  const d = await fixture(t);
  d.state.script = "printf partial > partial.txt\nfalse\nprintf wrong > should-not-run.txt";
  assert.match(await d.view.create(d.cx), /exit 1/);
  const path = d.view.created.path;
  assert.equal(await readFile(join(path, "partial.txt"), "utf8"), "partial");
  await assert.rejects(access(join(path, "should-not-run.txt")));
  assert.equal(d.state.opens.length, 0);
  d.state.script = "printf retried > retried.txt";
  assert.equal(await d.view.create(d.cx), "");
  assert.equal(d.view.created.path, path);
  assert.equal(await readFile(join(path, "retried.txt"), "utf8"), "retried");
});

test("real Bash pipefail prevents a failed pipeline from being reported as success", async t => {
  const d = await fixture(t);
  d.state.script = "false | true\nprintf wrong > should-not-run.txt";
  assert.match(await d.view.create(d.cx), /exit 1/);
  await assert.rejects(access(join(d.view.created.path, "should-not-run.txt")));
  assert.equal(d.state.opens.length, 0);
});

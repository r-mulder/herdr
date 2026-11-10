import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import { DEFAULTS_FILE, parseDefaults, loadRepoDefault, writeRepoDefault } from "./defaults.js";

const repo = { gitDir: "/projects/one/.git" };
const other = { gitDir: "/projects/two/.git" };

function storage(initial = null) {
  const state = { text: initial, writes: 0 };
  const io = {
    path: `/config/${DEFAULTS_FILE}`,
    readTextFile: async () => state.text,
    writeTextFile: async (_path, text, expected) => {
      if (state.text !== expected) throw new Error("stale file snapshot");
      state.text = text;
      state.writes++;
    },
  };
  return { state, io };
}

test("missing defaults are empty and the first explicit save creates the file", async () => {
  const { state, io } = storage();
  assert.equal(await loadRepoDefault(repo, null, io), null);
  assert.equal(state.writes, 0);
  await writeRepoDefault(repo, null, "bash ./scripts/setup.sh\n", null, io);
  assert.equal(await loadRepoDefault(repo, null, io), "bash ./scripts/setup.sh\n");
  assert.equal(JSON.parse(state.text).version, 1);
});

test("different repositories retain separate scripts", async () => {
  const { io } = storage();
  await writeRepoDefault(repo, null, "echo one", null, io);
  await writeRepoDefault(other, null, "echo two", null, io);
  assert.equal(await loadRepoDefault(repo, null, io), "echo one");
  assert.equal(await loadRepoDefault(other, null, io), "echo two");
});

test("repository identity uses the common Git directory, not its name or branch", async () => {
  const { io } = storage();
  await writeRepoDefault({ ...repo, name: "same-name", top: "/projects/one" }, null, "echo main", null, io);
  assert.equal(await loadRepoDefault({ ...repo, name: "feature", top: "/checkouts/feature" }, null, io), "echo main");
  assert.equal(await loadRepoDefault({ gitDir: "/another-clone/one/.git", name: "same-name" }, null, io), null);
});

test("local and remote repositories with identical paths are isolated", async () => {
  const { io } = storage();
  await writeRepoDefault(repo, null, "echo local", null, io);
  await writeRepoDefault(repo, "build-machine", "echo remote", null, io);
  assert.equal(await loadRepoDefault(repo, undefined, io), "echo local");
  assert.equal(await loadRepoDefault(repo, "build-machine", io), "echo remote");
  assert.equal(await loadRepoDefault(repo, "other-machine", io), null);
});

test("updates and removals preserve other repositories and extra metadata", async () => {
  const original = { version: 1, note: "keep", repositories: [{ machine: null, gitDir: repo.gitDir, script: "echo old", label: "keep too" }] };
  const { state, io } = storage(JSON.stringify(original));
  await writeRepoDefault(other, null, "echo two", null, io);
  await writeRepoDefault(repo, null, "echo updated", "echo old", io);
  assert.equal(JSON.parse(state.text).note, "keep");
  assert.equal(JSON.parse(state.text).repositories.find(entry => entry.gitDir === repo.gitDir).label, "keep too");
  await writeRepoDefault(repo, null, null, "echo updated", io);
  assert.equal(await loadRepoDefault(repo, null, io), null);
  assert.equal(await loadRepoDefault(other, null, io), "echo two");
});

test("a same-repository conflict fails without losing newer settings", async () => {
  const { state, io } = storage();
  await writeRepoDefault(repo, null, "echo newer", null, io);
  const before = state.text;
  await assert.rejects(writeRepoDefault(repo, null, "echo stale", null, io), /changed elsewhere/);
  assert.equal(state.text, before);
});

test("a concurrent whole-file change is rejected by the atomic write boundary", async () => {
  const { state, io } = storage();
  const write = io.writeTextFile;
  io.writeTextFile = async (...args) => { state.text = "newer external edit"; return write(...args); };
  await assert.rejects(writeRepoDefault(repo, null, "echo draft", null, io), /stale file/);
  assert.equal(state.text, "newer external edit");
});

for (const text of ["{broken", '{"version":2,"repositories":[]}', '{"version":1,"repositories":[{}]}']) {
  test(`invalid settings are preserved rather than replaced: ${text}`, async () => {
    const { state, io } = storage(text);
    await assert.rejects(loadRepoDefault(repo, null, io));
    await assert.rejects(writeRepoDefault(repo, null, "echo one", null, io));
    assert.equal(state.text, text);
    assert.equal(state.writes, 0);
  });
}

test("duplicate repository entries are rejected", () => {
  const entry = { machine: null, gitDir: repo.gitDir, script: "echo one" };
  assert.throws(() => parseDefaults(JSON.stringify({ version: 1, repositories: [entry, entry] })), /duplicate/);
});

test("saving blank text requires the explicit Remove default action", async () => {
  const { state, io } = storage();
  await assert.rejects(writeRepoDefault(repo, null, " \n ", null, io), /Remove default/);
  assert.equal(state.writes, 0);
});

const source = (await readFile(new URL("./main.js", import.meta.url), "utf8"))
  .replace(/^import .*;$/gm, "")
  .replace("export default class Worktree", "class Worktree") + "\nWorktree;";

function view(io, scriptProp) {
  let script = scriptProp ?? "";
  const Worktree = vm.runInNewContext(source, {
    View: class {}, loadRepoDefault, writeRepoDefault,
    props: () => scriptProp === undefined ? {} : { script: scriptProp },
  });
  const instance = new Worktree();
  Object.assign(instance, {
    repo, on: null, defaultsIO: io, scriptEdited: false,
    savedScript: null, defaultError: "", defaultNotice: "", defaultSaving: false, busy: false,
    script: { value: () => script, set_value: value => { script = value; } },
  });
  return instance;
}
const cx = { notify() {} };

test("the dialog preloads its repository default without writing or executing it", async () => {
  const { state, io } = storage();
  await writeRepoDefault(repo, null, "echo saved", null, io);
  const writes = state.writes;
  const dialog = view(io);
  await dialog.loadDefault(repo);
  assert.equal(dialog.script.value(), "echo saved");
  assert.equal(state.writes, writes);
});

test("explicit script props, including an explicit blank, override the default", async () => {
  const { io } = storage();
  await writeRepoDefault(repo, null, "echo saved", null, io);
  for (const script of ["echo once", ""]) {
    const dialog = view(io, script);
    await dialog.loadDefault(repo);
    assert.equal(dialog.script.value(), script);
  }
});

test("late loading cannot overwrite a draft typed while the file is read", async () => {
  const { io } = storage();
  await writeRepoDefault(repo, null, "echo saved", null, io);
  const read = io.readTextFile;
  let release;
  io.readTextFile = async () => { await new Promise(resolve => { release = resolve; }); return read(); };
  const dialog = view(io);
  const loading = dialog.loadDefault(repo);
  dialog.script.set_value("echo my draft");
  dialog.scriptEdited = true;
  release();
  await loading;
  assert.equal(dialog.script.value(), "echo my draft");
});

test("one-off changes are not persisted until Save repo default is used", async () => {
  const { io } = storage();
  await writeRepoDefault(repo, null, "echo saved", null, io);
  const dialog = view(io);
  await dialog.loadDefault(repo);
  dialog.script.set_value("echo new default");
  assert.equal(await loadRepoDefault(repo, null, io), "echo saved");
  await dialog.storeDefault(false, cx);
  assert.equal(await loadRepoDefault(repo, null, io), "echo new default");
});

test("Remove default deletes the saved value but keeps the current one-off draft", async () => {
  const { io } = storage();
  await writeRepoDefault(repo, null, "echo saved", null, io);
  const dialog = view(io);
  await dialog.loadDefault(repo);
  await dialog.storeDefault(true, cx);
  assert.equal(await loadRepoDefault(repo, null, io), null);
  assert.equal(dialog.script.value(), "echo saved");
  assert.match(dialog.defaultNotice, /current script kept/);
});

test("unreadable defaults block creation instead of silently skipping a saved setup", async () => {
  const { io } = storage("broken JSON");
  const dialog = view(io);
  await dialog.loadDefault(repo);
  assert.match(dialog.defaultError, /valid JSON/);
  // No exec/run is provided: reaching either would throw and fail this test.
  await dialog.work(cx);
  assert.equal(dialog.busy, false);
});

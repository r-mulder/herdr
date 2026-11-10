// Explicit local preferences, never read from or written into a repository.
export const DEFAULTS_FILE = "worktree-scripts.json";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const key = (machine, gitDir) => JSON.stringify([machine ?? null, gitDir]);

export function parseDefaults(text) {
  if (text === null) return { version: 1, repositories: [] };
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`${DEFAULTS_FILE} is not valid JSON. Fix the file before continuing.`); }
  if (!object(data) || data.version !== 1 || !Array.isArray(data.repositories)) throw new Error(`${DEFAULTS_FILE} needs version 1 and a repositories array.`);
  const seen = new Set();
  for (const entry of data.repositories) {
    if (!object(entry) || !(entry.machine === null || (typeof entry.machine === "string" && entry.machine.length > 0)) || typeof entry.gitDir !== "string" || !entry.gitDir || typeof entry.script !== "string") throw new Error(`${DEFAULTS_FILE} has an invalid repository entry.`);
    const id = key(entry.machine, entry.gitDir);
    if (seen.has(id)) throw new Error(`${DEFAULTS_FILE} has duplicate entries for one repository.`);
    seen.add(id);
  }
  return data;
}

function identity(repo, machine) {
  if (typeof repo?.gitDir !== "string" || !repo.gitDir) throw new Error("The repository's shared Git directory is not known yet.");
  return key(machine, repo.gitDir);
}

export async function loadRepoDefault(repo, machine, io) {
  const id = identity(repo, machine);
  const data = parseDefaults(await io.readTextFile(io.path));
  return data.repositories.find(entry => key(entry.machine, entry.gitDir) === id)?.script ?? null;
}

// Re-read before writing so saving repo A preserves a concurrently saved repo B.
// Same-repo conflicts and stale file snapshots fail without overwriting anything.
export async function writeRepoDefault(repo, machine, script, expectedScript, io) {
  const id = identity(repo, machine);
  if (script !== null && (typeof script !== "string" || !script.trim())) throw new Error("Enter a script to save, or use Remove default.");
  const text = await io.readTextFile(io.path);
  const data = parseDefaults(text);
  const existing = data.repositories.find(entry => key(entry.machine, entry.gitDir) === id);
  if ((existing?.script ?? null) !== expectedScript) throw new Error("This repo's default changed elsewhere. Reopen New worktree before saving again.");
  if (script === null && !existing) return;
  const repositories = data.repositories.filter(entry => key(entry.machine, entry.gitDir) !== id);
  if (script !== null) repositories.push({ ...existing, machine: machine ?? null, gitDir: repo.gitDir, script });
  await io.writeTextFile(io.path, `${JSON.stringify({ ...data, repositories }, null, 2)}\n`, text);
}

// The test command a repository already declares, read from its files: `files` maps a name at the repo root to its
// text, or null when it is not there. Pure, so tests feed it files.
const NPM_DEFAULT = /no test specified/;

export function detectChecks(files) {
  const pkg = (() => { try { return JSON.parse(files["package.json"] ?? "null"); } catch { return null; } })();
  const test = pkg?.scripts?.test;
  if (typeof test === "string" && test.trim() && !NPM_DEFAULT.test(test)) {
    const runner = files["pnpm-lock.yaml"] != null ? "pnpm" : files["yarn.lock"] != null ? "yarn" : files["bun.lock"] != null || files["bun.lockb"] != null ? "bun" : "npm";
    return [[runner, "test"]];
  }
  if (files["go.mod"] != null) return [["go", "test", "./..."]];
  if (files["Cargo.toml"] != null) return [["cargo", "test"]];
  if (files["pytest.ini"] != null || /\[tool\.pytest/.test(files["pyproject.toml"] ?? "")) return [["pytest"]];
  if (/^test:/m.test(files.Makefile ?? "")) return [["make", "test"]];
  return null;
}

export const CHECK_FILES = ["package.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "go.mod", "Cargo.toml", "pytest.ini", "pyproject.toml", "Makefile"];

// A check list in a few words: "npm test", "go test ./...", "2 checks", "no tests".
export const checksLabel = (checks) => (!checks?.length ? "no tests" : checks.length === 1 ? checks[0].join(" ") : `${checks.length} checks`);

// Test commands as a person types them, "npm test; make lint", and back. Quotes keep an argument with spaces whole;
// a JSON list of argument lists, the older form, still reads.
const quote = (arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`);
export const checksText = (checks) => (checks ?? []).map((argv) => argv.map(quote).join(" ")).join("; ");

export function parseChecks(text) {
  const value = String(text ?? "").trim();
  if (!value) return [];
  if (value.startsWith("[")) return JSON.parse(value);
  return value.split(/;|\n/).map((command) => {
    if ((command.replace(/\\./g, "").match(/"/g)?.length ?? 0) % 2) throw Error(`A quote isn't closed in: ${command.trim()}`);
    const args = [];
    for (const m of command.matchAll(/"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g)) args.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2] ?? m[3]);
    return args;
  }).filter((args) => args.length);
}

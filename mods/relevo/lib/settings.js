// config.js as data: rendering it back to source and checking a setup before it is written.

const WIDTH = 130;
const SKILL_KEYS = ["review", "fix", "comments"];
const ACCOUNT_FIELDS = ["key", "label", "letter", "launcher", "bg", "fg"];

// sh -c WRITE_SCRIPT sh <path> <text>: a hidden temp file in the same folder, then one rename,
// so the mod never reloads a half-written config.
export const WRITE_SCRIPT = 'tmp=$(mktemp "$(dirname "$1")/.config.XXXXXX") || exit 1; '
  + 'printf "%s" "$2" > "$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$1" || { rm -f "$tmp"; exit 1; }';

export const slug =(label) => (label ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const parseList = (text) => (text ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const isHex = (c) => /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c ?? "");

const keyText = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

function value(v) {
  if (Array.isArray(v)) return `[${v.map(value).join(", ")}]`;
  if (v && typeof v === "object") return `{ ${Object.entries(v).map(([k, x]) => `${keyText(k)}: ${value(x)}`).join(", ")} }`;
  return JSON.stringify(v);
}

// One line when it fits, else its fields packed onto lines under WIDTH, like config.example.js.
function block(obj, indent, prefix, suffix) {
  const pad = " ".repeat(indent);
  const line = `${pad}${prefix}${value(obj)}${suffix}`;
  if (line.length <= WIDTH) return line;
  const inner = " ".repeat(indent + 2), rows = [];
  let row = "";
  for (const [k, x] of Object.entries(obj)) {
    const field = `${keyText(k)}: ${value(x)},`;
    if (row && inner.length + row.length + 1 + field.length > WIDTH) {
      rows.push(inner + row);
      row = field;
    } else {
      row = row ? `${row} ${field}` : field;
    }
  }
  if (row) rows.push(inner + row);
  return [`${pad}${prefix}{`, ...rows, `${pad}}${suffix}`].join("\n");
}

const list = (name, items) => [`export const ${name} = [`, ...items.map((o) => block(o, 2, "", ",")), "];"].join("\n");

const flat = (name, v) => {
  const line = `export const ${name} = ${value(v)};`;
  if (line.length <= WIDTH || !Array.isArray(v)) return line;
  return [`export const ${name} = [`, ...v.map((x) => `  ${value(x)},`), "];"].join("\n");
};

export function renderConfig(c) {
  return [
    "// Everything personal to one setup: accounts, contexts, folders and skills. Relevo's Settings rewrites this file.",
    "",
    "// Each Claude account: `launcher` is the shell command that starts it, `claudeDir` its",
    "// CLAUDE_CONFIG_DIR under home, `bg`/`fg` its chip colors.",
    list("ACCOUNTS", c.ACCOUNTS),
    "",
    block(c.CODEX, 0, "export const CODEX = ", ";"),
    "",
    "// The first context is the default. The others claim the repos whose GitHub owner is in `orgs`,",
    "// and each gets a space folder with that key.",
    list("CONTEXTS", c.CONTEXTS),
    "",
    "// Who takes over when the repo's account is out of quota, in order.",
    flat("FALLBACK", c.FALLBACK),
    "",
    "// Clones live directly under this folder in home.",
    flat("REPOS_ROOT", c.REPOS_ROOT),
    "",
    "// Where Save patch and Save commits write, under home.",
    flat("BACKUPS_ROOT", c.BACKUPS_ROOT ?? "relevo-backups"),
    "",
    "// The slash commands the Inbox launches on a PR: a review, a CI fix and answering review comments.",
    block(c.SKILLS, 0, "export const SKILLS = ", ";"),
    "",
    "// What the quick replies menu offers to send an agent (⌥⌘S, or ↩ beside an agent).",
    flat("REPLIES", c.REPLIES ?? []),
    "",
  ].join("\n");
}

// Errors as { at, message }; `at` names the field ("accounts.1.bg", "codex.launcher", "fallback").
export function validate(c) {
  const errors = [];
  const fail = (at, message) => errors.push({ at, message });
  const accounts = c.ACCOUNTS ?? [], contexts = c.CONTEXTS ?? [];
  if (!accounts.length) fail("accounts", "Add at least one account");
  const seen = new Set();
  accounts.forEach((a, i) => {
    const name = a.label || `Account ${i + 1}`;
    for (const field of [...ACCOUNT_FIELDS, "claudeDir"]) {
      if (!a[field]?.trim()) fail(`accounts.${i}.${field}`, `${name}: ${field} is required`);
    }
    if (a.key && !/^[A-Za-z0-9_-]+$/.test(a.key)) fail(`accounts.${i}.key`, `${name}: the key takes letters, digits and dashes`);
    else if (a.key && (seen.has(a.key) || a.key === c.CODEX?.key)) fail(`accounts.${i}.key`, `${name}: key "${a.key}" is taken`);
    seen.add(a.key);
    if (a.letter && [...a.letter].length > 2) fail(`accounts.${i}.letter`, `${name}: the letter is one or two characters`);
    for (const field of ["bg", "fg"]) {
      if (a[field] && !isHex(a[field])) fail(`accounts.${i}.${field}`, `${name}: ${field} is a hex color like #1e2030`);
    }
  });
  for (const field of ACCOUNT_FIELDS) if (!c.CODEX?.[field]?.trim()) fail(`codex.${field}`, `Codex: ${field} is required`);
  if (!contexts.length) fail("contexts", "Add at least one context");
  const contextKeys = new Set();
  contexts.forEach((ctx, i) => {
    const name = ctx.label || `Context ${i + 1}`;
    if (!ctx.label?.trim()) fail(`contexts.${i}.label`, `Context ${i + 1}: label is required`);
    else if (!ctx.key) fail(`contexts.${i}.label`, `${name}: the label needs a letter or digit`);
    else if (contextKeys.has(ctx.key)) fail(`contexts.${i}.label`, `${name}: key "${ctx.key}" is taken`);
    contextKeys.add(ctx.key);
    if (!seen.has(ctx.account)) fail(`contexts.${i}.account`, `${name}: pick one of the accounts`);
  });
  if (contexts[0]?.orgs?.length) fail("contexts.0.orgs", "The first context is the default and claims no orgs");
  const fallback = c.FALLBACK ?? [];
  for (const k of fallback) if (!seen.has(k)) fail("fallback", `Fallback: "${k}" is not an account key`);
  if (new Set(fallback).size !== fallback.length) fail("fallback", "Fallback: each account once");
  const root = c.REPOS_ROOT ?? "";
  if (!root.trim()) fail("reposRoot", "Repos root is required");
  else if (root.startsWith("/") || root.startsWith("~")) fail("reposRoot", "Repos root is relative to home, like code");
  const backups = c.BACKUPS_ROOT ?? "relevo-backups";
  if (!backups.trim()) fail("backupsRoot", "Backups folder is required");
  else if (backups.startsWith("/") || backups.startsWith("~")) fail("backupsRoot", "Backups folder is relative to home, like relevo-backups");
  const skills = c.SKILLS ?? {};
  if (Object.keys(skills).sort().join() !== [...SKILL_KEYS].sort().join()) fail("skills", "Skills: review, fix and comments");
  for (const k of SKILL_KEYS) if (k in skills && !skills[k]?.trim()) fail(`skills.${k}`, `Skills: ${k} is required`);
  if (new Set(c.REPLIES ?? []).size !== (c.REPLIES ?? []).length) fail("replies", "Replies: each one once");
  return errors;
}

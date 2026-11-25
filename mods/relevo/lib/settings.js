// config.js as data: rendering it back to source and checking a setup before it is written.
import { DEFAULT_DEEP_REVIEW, checkDeepReview } from "./deep-setup.js";
import { OWNER } from "./github.js";
import { PROVIDERS, providerOf } from "./providers.js";

const WIDTH = 130;
const SKILL_KEYS = ["review", "fix", "comments"];
const ACCOUNT_FIELDS = ["key", "label", "letter", "launcher", "bg", "fg"];

// sh -c WRITE_SCRIPT sh <path> <text>: a hidden temp file in the same folder, then one rename,
// so the mod never reloads a half-written config.
export const WRITE_SCRIPT = 'umask 077; tmp=$(mktemp "$(dirname "$1")/.config.XXXXXX") || exit 1; '
  + 'printf "%s" "$2" > "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$1" || { rm -f "$tmp"; exit 1; }';

export const slug =(label) => (label ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const parseList = (text) => (text ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// The ABOUT line: what is installed, and a newer release when GitHub has one.
export function aboutLine({ relevo, herdr, latest }) {
  const parts = [`Relevo ${relevo ?? "not installed by install.sh"}`, herdr && `Herdr ${herdr}`].filter(Boolean);
  const update = relevo && newer(latest, relevo) ? `${latest} available: git pull --ff-only, then ./install.sh` : null;
  return { text: parts.join(" · "), update };
}

const parts = (v) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "")?.slice(1).map(Number) ?? null;
// Whether `a` is a later x.y.z than `b`; anything else is never newer.
export function newer(a, b) {
  const x = parts(a), y = parts(b);
  if (!x || !y) return false;
  const i = x.findIndex((n, k) => n !== y[k]);
  return i >= 0 && x[i] > y[i];
}

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

// What Settings edits; anything else config.js exports is written back as it was.
const EDITED = ["ACCOUNTS", "CODEX", "USE_CODEX", "OTHER_CLIS", "IGNORED_CLIS", "CONTEXTS", "FALLBACK", "REPOS_ROOT", "BACKUPS_ROOT", "SKILLS", "REPLIES", "DEEP_REVIEW", "REVIEW_OWNERS"];
const NOTES = {
  RUN_CODEX_MODEL: "// The model a run's Codex agent uses.",
  RUN_MUST_FIX: "// A run's reviewer sends the work back only for findings at this level or above: \"blocker\", \"major\" or \"minor\".",
  RUN_DRAFT_PR: "// false: accepting a run in its own worktree only commits to its branch, without opening the draft pull request.",
  RUN_SANDBOX: "// true: a run's agents also keep Bash in the OS sandbox, where builds that need the network fail.",
};

function others(c) {
  return Object.entries(c).filter(([name, v]) => !EDITED.includes(name) && /^[A-Za-z_$][\w$]*$/.test(name) && v !== undefined && typeof v !== "function")
    .flatMap(([name, v]) => [...(NOTES[name] ? [NOTES[name]] : []),
      v && typeof v === "object" && !Array.isArray(v) ? block(v, 0, `export const ${name} = `, ";") : flat(name, v), ""]);
}

export function renderConfig(c) {
  return [
    "// Everything personal to one setup: accounts, contexts, folders and skills. Relevo's Settings rewrites this file.",
    "",
    "// Each Claude account: `launcher` is the shell command that starts it, `claudeDir` its",
    "// CLAUDE_CONFIG_DIR under home, `bg`/`fg` its chip colors, `provider` its CLI (lib/providers.js; \"claude\" if unset).",
    list("ACCOUNTS", c.ACCOUNTS),
    "",
    block(c.CODEX, 0, "export const CODEX = ", ";"),
    "// false: Codex stays out of every account list and every default (runs, second opinions, deep reviews, handoffs).",
    flat("USE_CODEX", c.USE_CODEX ?? true),
    "",
    "// Other CLIs with one login each (`provider` and `key` alike, lib/providers.js), added from Reviews; `on: false` turns one off.",
    list("OTHER_CLIS", c.OTHER_CLIS ?? []),
    "// The CLIs Reviews found and you turned down: it doesn't offer them again.",
    flat("IGNORED_CLIS", c.IGNORED_CLIS ?? []),
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
    "// Who reviews a PR in Deep review: an account (\"repo\" is the repo's own), its model (empty: the default) and effort.",
    list("DEEP_REVIEW", c.DEEP_REVIEW ?? DEFAULT_DEEP_REVIEW),
    "",
    "// GitHub users or orgs whose repos' open PRs by others show in Reviews, asked or not; \"@me\" is you, [] only review requests.",
    flat("REVIEW_OWNERS", c.REVIEW_OWNERS ?? ["@me"]),
    "",
    ...others(c),
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
    for (const field of [...ACCOUNT_FIELDS, ...(providerOf(a).key === "claude" ? ["claudeDir"] : [])]) {
      if (!a[field]?.trim()) fail(`accounts.${i}.${field}`, `${name}: ${field} is required`);
    }
    if (a.provider && !PROVIDERS[a.provider]) fail(`accounts.${i}.provider`, `${name}: provider is one of ${Object.keys(PROVIDERS).join(", ")}`);
    if (a.key && !/^[A-Za-z0-9_-]+$/.test(a.key)) fail(`accounts.${i}.key`, `${name}: the key takes letters, digits and dashes`);
    else if (a.key && (seen.has(a.key) || a.key === c.CODEX?.key)) fail(`accounts.${i}.key`, `${name}: key "${a.key}" is taken`);
    seen.add(a.key);
    if (a.letter && [...a.letter].length > 2) fail(`accounts.${i}.letter`, `${name}: the letter is one or two characters`);
    for (const field of ["bg", "fg"]) {
      if (a[field] && !isHex(a[field])) fail(`accounts.${i}.${field}`, `${name}: ${field} is a hex color like #1e2030`);
    }
  });
  for (const field of ACCOUNT_FIELDS) if (!c.CODEX?.[field]?.trim()) fail(`codex.${field}`, `Codex: ${field} is required`);
  const clis = new Set();
  (c.OTHER_CLIS ?? []).forEach((a, i) => {
    const p = PROVIDERS[a.provider], name = a.label || p?.name || `CLI ${i + 1}`;
    if (!p || p.caps.accounts || p.key === "codex") fail(`otherClis.${i}.provider`, `${name}: provider is a one-login CLI other than Codex`);
    else if (a.key !== p.key) fail(`otherClis.${i}.key`, `${name}: its key is "${p.key}", as its provider`);
    else if (seen.has(a.key) || clis.has(a.key)) fail(`otherClis.${i}.key`, `${name}: key "${a.key}" is taken`);
    for (const field of ACCOUNT_FIELDS) if (!a[field]?.trim?.()) fail(`otherClis.${i}.${field}`, `${name}: ${field} is required`);
    clis.add(a.key);
  });
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
  // A conflicts skill is optional: without one, the built-in prompt runs.
  const keys = Object.keys(skills).filter((k) => k !== "conflicts");
  if (keys.sort().join() !== [...SKILL_KEYS].sort().join()) fail("skills", "Skills: review, fix and comments");
  for (const k of SKILL_KEYS) if (k in skills && !skills[k]?.trim()) fail(`skills.${k}`, `Skills: ${k} is required`);
  for (const o of c.REVIEW_OWNERS ?? []) if (!OWNER.test(o)) fail("reviewOwners", `Reviews: "${o}" is not a GitHub user or org`);
  if (new Set(c.REPLIES ?? []).size !== (c.REPLIES ?? []).length) fail("replies", "Replies: each one once");
  const runnable = (c.OTHER_CLIS ?? []).filter((a) => PROVIDERS[a.provider]?.caps.runs);
  errors.push(...checkDeepReview(c.DEEP_REVIEW ?? DEFAULT_DEEP_REVIEW, [...accounts, ...(c.CODEX?.key ? [{ ...c.CODEX, provider: "codex" }] : []), ...runnable]));
  return errors;
}

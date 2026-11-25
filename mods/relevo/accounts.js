import { home, readTextFile, run, spaces, shared, terminals } from "herdr";
import { ACCOUNTS as CONFIGURED, CODEX as CODEX_ACCOUNT, FALLBACK } from "./config.js";
import * as config from "./config.js";
import { FIVE_HOURS, WEEK, windowOf, windowLabel } from "./lib/time.js";
import { accountFor } from "./context.js";
import { shellArgv } from "./lib/session-env.js";
import { PROVIDERS, providerOf, providerOfApp, quotaOf } from "./lib/providers.js";

export const API_QUOTAS = "relevo.quota.api";
export const quotaError = (key) => shared(API_QUOTAS)?.[key]?.error ?? null;

// `file` is the statusline's quota snapshot for that account.
const withFile = (a, provider) => ({ ...a, provider: a.provider ?? provider, file: `quota-${a.key}.json` });
export const ACCOUNTS = CONFIGURED.map((a) => withFile(a, "claude"));
export const CODEX = withFile(CODEX_ACCOUNT, "codex");
// The other CLIs with one login each, added from Reviews when Relevo finds them.
export const OTHERS = (config.OTHER_CLIS ?? []).map((a) => withFile(a, a.provider));

// Every account the config names, on or off.
export const allAccounts = () => [...ACCOUNTS, CODEX, ...OTHERS];
export const accountOf = (key) => allAccounts().find((p) => p.key === key) ?? ACCOUNTS[0];
export const providerFor = (key) => providerOf(accountOf(key));
export const knownAccount = (key) => allAccounts().some((a) => a.key === key);
// The accounts whose own Claude Code files (history, transcripts) Relevo reads.
export const claudeAccounts = () => ACCOUNTS.filter((a) => providerOf(a) === PROVIDERS.claude && a.claudeDir);
// Which CLIs the machine has, { bin: boolean }: Reviews looks once. One not looked for yet counts as there.
export const CLI_FOUND = "relevo.cli.found";
export const cliFound = (bin) => shared(CLI_FOUND)?.[bin] !== false;
// A one-login CLI is off with USE_CODEX = false (Codex) or `on: false` (the others), and on a machine without it:
// then it stays out of every list and every default.
export const isOn = (a) => {
  const p = providerOf(a);
  if (p.caps.accounts) return true;
  return (a.key === CODEX.key ? config.USE_CODEX !== false : a.on !== false) && cliFound(p.bin);
};
export const codexOn = () => isOn(CODEX);
export const agentAccounts = () => allAccounts().filter(isOn);
// The accounts whose CLI Relevo can run unattended: Runs and Deep review offer only these.
export const runnableAccounts = () => agentAccounts().filter((a) => providerOf(a).caps.runs);

export { shellArgv } from "./lib/session-env.js";

// `args` go before the prompt as positional parameters, never into the shell text.
export function launchArgv(key, prompt, args = []) {
  const p = accountOf(key), lead = prompt ? providerOf(p).promptArgs(prompt) : [];
  const ref = (from) => (_, i) => ` "$${i + from}"`;
  return shellArgv(`${p.launcher}${args.map(ref(lead.length + 1)).join("")}${lead.map(ref(1)).join("")}`, ...lead, ...args);
}


export function fromClaude(json) {
  const r = json?.rate_limits ?? {};
  return {
    updated: json?.updated ?? 0,
    h5: windowOf(r.five_hour?.used_percentage, r.five_hour?.resets_at, FIVE_HOURS),
    d7: windowOf(r.seven_day?.used_percentage, r.seven_day?.resets_at, r.seven_day?.window_seconds ?? WEEK),
  };
}

// The newest source that still has this window: one without it, or whose window ended, says nothing about the current one.
export function currentWindow(sources, name, now) {
  const known = sources.map((s) => s.rate_limits?.[name]).filter((w) => w?.used_percentage != null);
  return known.find((w) => !w.resets_at || w.resets_at > now) ?? known[0];
}

// The usage endpoint (shared state) and the statusline snapshot (file), window by window.
export async function loadClaudeQuotas() {
  const out = {}, api = shared(API_QUOTAS) ?? {};
  for (const p of allAccounts()) {
    // What an agent just reported beats a usage report read minutes ago.
    const reported = providerOf(p).reportsQuota ? reportedQuota(providerOf(p), terminals()) : null;
    if (reported) {
      out[p.key] = reported;
      continue;
    }
    let file = null;
    try {
      file = JSON.parse(await readTextFile(`${home()}/.cache/herdr-relevo/${p.file}`) ?? "null");
    } catch {
      file = null;
    }
    const fromApi = api[p.key]?.rate_limits ? api[p.key] : null;
    const sources = [fromApi, file].filter(Boolean).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    if (!sources.length) {
      out[p.key] = null;
      continue;
    }
    const now = Date.now() / 1000, groups = sources.find((s) => s.rate_limits?.groups)?.rate_limits.groups;
    out[p.key] = fromClaude({
      updated: sources[0].updated,
      rate_limits: { five_hour: currentWindow(sources, "five_hour", now), seven_day: currentWindow(sources, "seven_day", now) },
    });
    // A CLI whose models draw on separate quotas (Antigravity: Gemini, Claude/GPT) shows each one.
    if (groups?.length > 1) {
      out[p.key].groups = groups.map((g) => ({ name: g.name, label: g.label, ...fromClaude({ updated: sources[0].updated, rate_limits: g }) }));
    }
  }
  return out;
}

// A CLI is full while one of its agents reports its quota reached.
export function reportedQuota(provider, list) {
  const hit = list.map((k) => providerOfApp(k.agent) === provider && quotaOf(k.report?.msg)).find(Boolean);
  return hit ? { updated: Math.floor(Date.now() / 1000), h5: windowOf(100, hit.resets, FIVE_HOURS), d7: null } : null;
}

export const full = (q) => (q?.h5?.pct >= 100 ? "5h" : q?.d7?.pct >= 100 ? windowLabel(q.d7, "7d") : null);

// Past this share of either window a new agent starts on another account: the rest goes in minutes.
export const NEAR_FULL = 90;
const used = (q) => Math.max(q?.h5?.pct ?? 0, q?.d7?.pct ?? 0);
export const hasRoom = (q) => used(q) < NEAR_FULL;
const tightWindow = (q) => ((q?.h5?.pct ?? 0) >= (q?.d7?.pct ?? 0) ? "5h" : windowLabel(q.d7, "7d"));

// The repo's account unless it is nearly out of quota; then the fallback with the most left, known before unknown.
export const pickAccount = (repo, quotas) => withRoom(accountFor(repo), quotas);

export function withRoom(key, quotas) {
  const q = quotas?.[key];
  if (used(q) < NEAR_FULL) return { key, note: null };
  const alt = FALLBACK.filter((k) => k !== key && used(quotas?.[k]) < NEAR_FULL)
    .map((k, i) => ({ k, i, rank: quotas?.[k] ? used(quotas[k]) : 100 }))
    .sort((x, y) => x.rank - y.rank || x.i - y.i)[0]?.k;
  return alt
    ? { key: alt, note: `${accountOf(key).label} is at ${Math.round(used(q))}% (${tightWindow(q)}) — using ${accountOf(alt).label}` }
    : { key, note: null };
}

const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The session id goes as a positional parameter, never into the shell text.
export const resumeArgv = (key, id) => {
  if (!SESSION_UUID.test(String(id ?? ""))) throw Error("Invalid session id");
  return shellArgv(`${accountOf(key).launcher} --resume "$1"`, id);
};

// A tab in the folder's space, else in the repo's, else a new space.
export function openInFolder({ name, folder, tab, argv }) {
  const space = spaces().find((s) => !s.machine && s.folder === folder)
    ?? spaces().find((s) => !s.machine && s.name === name);
  if (space) run("tab.new", { space: space.id, name: tab, folder, argv });
  else run("space.new", { name, folder, tab, argv, machine: "" });
}

// Runs in the repo's own space (or a new one), not in whichever space is shown.
export function launchInRepo({ repo, folder, tab, account, prompt }) {
  openInFolder({ name: repo.split("/").pop(), folder, tab, argv: launchArgv(account, prompt) });
}

export function chip(div, p, size = 17) {
  return div().size(size).flex_none().rounded(5).bg(p.bg).text_color(p.fg).text_size(size * 0.6).font_semibold()
    .flex().items_center().justify_center()
    .child(p.letter);
}

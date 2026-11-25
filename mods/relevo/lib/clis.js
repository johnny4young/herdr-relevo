// Which agent CLIs the machine has and how their Herdr hooks stand, and what Reviews offers for each. Pure.
import { PROVIDERS } from "./providers.js";

// One sh script: the name of each CLI found on PATH, one per line.
export const FIND_SCRIPT = 'for b in "$@"; do command -v "$b" >/dev/null 2>&1 && echo "$b"; done; exit 0';
export const bins = () => Object.values(PROVIDERS).map((p) => p.bin);

// `herdr integration status`: "codex: outdated (v9 < v10) (/path)" → { codex: { state: "outdated", have: 9, want: 10 } }.
export function parseIntegrations(text) {
  const out = {};
  for (const line of (text ?? "").split("\n")) {
    const m = /^([\w-]+)(?: \([^)]*\))?: (current|outdated|not installed)(?: \(v(\d+)(?: < v(\d+))?\))?/.exec(line.trim());
    if (m) out[m[1]] = { state: m[2], have: m[3] ? Number(m[3]) : null, want: m[4] ? Number(m[4]) : m[3] ? Number(m[3]) : null };
  }
  return out;
}

const hook = (integration) => (integration?.state === "current" ? null : integration?.state ?? null);

// What Reviews offers: a one-login CLI found but not in config.js ("new"), and a configured, on CLI whose Herdr hook
// is outdated or missing ("hook"). `found` is { bin: boolean }; `configured` the provider keys config.js names;
// `on` those of them in use; `ignored` the provider keys turned down.
export function cliOffers({ found, integrations, configured, on, ignored }) {
  const offers = [];
  for (const p of Object.values(PROVIDERS)) {
    if (!found?.[p.bin]) continue;
    const state = integrations ? hook(integrations[p.integration]) : null;
    if (!configured.includes(p.key)) {
      if (!p.caps.accounts && !ignored.includes(p.key)) offers.push({ provider: p.key, kind: "new", hook: state });
    } else if (on.includes(p.key) && state) offers.push({ provider: p.key, kind: "hook", hook: state });
  }
  return offers;
}

// The account config.js gets for a one-login CLI: its key is the provider's, as a terminal's app names it.
export function newAccount(key) {
  const p = PROVIDERS[key];
  if (!p || p.caps.accounts) return null;
  return { key: p.key, provider: p.key, ...p.chip, launcher: p.bin };
}

// config.js's values once a CLI is activated or ignored; the rest is written back as it was.
export function withCli(config, key, choice) {
  const others = config.OTHER_CLIS ?? [], ignored = config.IGNORED_CLIS ?? [];
  if (choice === "ignore") return { ...config, IGNORED_CLIS: [...new Set([...ignored, key])] };
  const account = newAccount(key);
  if (!account) return config;
  return { ...config, OTHER_CLIS: [...others.filter((a) => a.key !== key), account], IGNORED_CLIS: ignored.filter((k) => k !== key) };
}

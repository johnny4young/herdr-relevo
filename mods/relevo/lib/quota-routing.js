// Pre-flight quota risk and alternate-account routing shared by Inbox, Runs, Deep review and Handoff alerts.
import { fullIn, windowLabel } from "./time.js";

export const NEAR_FULL = 90;
export const TIGHT_MINUTES = 15;

export const usedOf = (q) => Math.max(q?.h5?.pct ?? 0, q?.d7?.pct ?? 0);
export const tightWindow = (q) => ((q?.h5?.pct ?? 0) >= (q?.d7?.pct ?? 0) ? "5h" : windowLabel(q?.d7, "7d"));

// Returns null while an account has comfortable room, else why starting new work there is risky.
export function quotaRisk(q, { nearFull = NEAR_FULL, tightMinutes = TIGHT_MINUTES, now = Date.now() / 1000 } = {}) {
  if (!q) return null;
  const pct = Math.round(usedOf(q)), win = tightWindow(q);
  if (pct >= 100) return { level: "full", pct, minutes: 0, window: win, reason: `is full (${win})` };
  const m5 = fullIn(q.h5, now), m7 = fullIn(q.d7, now);
  const minutes = [m5, m7].filter((m) => m != null).sort((a, b) => a - b)[0] ?? null;
  if (minutes !== null && minutes <= tightMinutes) {
    const w = m5 === minutes ? "5h" : windowLabel(q.d7, "7d");
    return { level: "tight", pct, minutes, window: w, reason: `fills in ${minutes}m (${w})` };
  }
  if (pct >= nearFull) return { level: "near", pct, minutes, window: win, reason: `is at ${pct}% (${win})` };
  return null;
}

// Best alternate account with comfortable room, preferring known lowest usage over unknown.
export function bestAlternate(key, candidates, quotas, opts = {}) {
  const pick = [...new Set(candidates)]
    .filter((k) => k && k !== key && !quotaRisk(quotas?.[k], opts))
    .map((k, i) => ({ k, i, rank: quotas?.[k] ? usedOf(quotas[k]) : 100 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)[0];
  if (!pick) return null;
  const q = quotas?.[pick.k];
  return { key: pick.k, room: q ? Math.max(0, Math.round(100 - usedOf(q))) : null };
}

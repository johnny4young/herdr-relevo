export const QUOTA_STALE_SECONDS = 30 * 60;
export const QUOTA_WARN = 80;
// From here an account's agent is offered another account, before it stops.
export const HANDOFF_AT = 95;
const DOT_COUNT = 20;
import { ago, fullIn, windowLabel } from './time.js';
const WINDOW_LABEL = { h5: '5h', d7: '7d' };

export function quotaRingDots(pct) {
  const count = Number.isFinite(pct) ? Math.round(Math.max(0, Math.min(100, pct)) / 5) : 0;
  return Array.from({ length: DOT_COUNT }, (_, index) => {
    const angle = -Math.PI / 2 + 2 * Math.PI * index / DOT_COUNT;
    return { index, x: Math.round(8 + 6.5 * Math.cos(angle) - 1), y: Math.round(8 + 6.5 * Math.sin(angle) - 1), active: index < count };
  });
}

// The window closest to its limit is the one that stops work, whichever it is.
export function tightestWindow(quota) {
  const windows = ['h5', 'd7'].filter((name) => Number.isFinite(quota?.[name]?.pct)).map((name) => ({ name, ...quota[name] }));
  return windows.sort((a, b) => b.pct - a.pct)[0] ?? null;
}

export function quotaFreshness(quota, now = Date.now() / 1000) {
  if (!tightestWindow(quota)) return 'unknown';
  if (!Number.isFinite(quota.updated) || now - quota.updated > QUOTA_STALE_SECONDS) return 'stale';
  return 'fresh';
}

export function quotaStatusText(quota, freshness = quotaFreshness(quota)) {
  const window = tightestWindow(quota);
  if (!window) return 'Usage unavailable';
  const reset = Number.isFinite(window.resets) ? ` · resets ${new Date(window.resets * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
  return `${windowLabel(window, WINDOW_LABEL[window.name])} ${Math.round(window.pct)}% used${freshness === 'stale' ? ' (stale)' : ''}${reset}`;
}

export function readAge(updated) {
  if (!Number.isFinite(updated)) return 'read time unknown';
  const age = ago(updated);
  return age === 'now' ? 'read just now' : `read ${age}`;
}

// The one thing to say beside an account's name: what stops work first, then what the reading is worth.
export function accountNote(quota, { focused = false, now = Date.now() / 1000 } = {}) {
  const freshness = quotaFreshness(quota, now);
  if (freshness === 'stale') return { kind: 'stale', text: `stale · ${readAge(quota.updated)}` };
  if (freshness === 'fresh') {
    const minutes = [quota.h5, quota.d7].map((w) => fullIn(w, now)).filter((m) => m != null && m <= 60).sort((a, b) => a - b)[0];
    if (minutes != null) return { kind: 'full-soon', text: `full in ${minutes} min at this pace` };
  }
  if (focused) return { kind: 'focused', text: 'focused repository' };
  const tight = tightestWindow(quota);
  if (tight?.name === 'd7' && tight.pct >= 50) return { kind: 'long', text: `${windowLabel(tight, 'weekly')} window is the tight one` };
  return null;
}

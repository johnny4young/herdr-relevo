export const QUOTA_STALE_SECONDS = 30 * 60;
export const QUOTA_WARN = 80;
const DOT_COUNT = 20;
import { windowLabel } from './time.js';
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

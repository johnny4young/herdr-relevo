export const QUOTA_STALE_SECONDS = 30 * 60;
const DOT_COUNT = 20;

export function quotaRingDots(pct) {
  const count = Number.isFinite(pct) ? Math.round(Math.max(0, Math.min(100, pct)) / 5) : 0;
  return Array.from({ length: DOT_COUNT }, (_, index) => {
    const angle = -Math.PI / 2 + 2 * Math.PI * index / DOT_COUNT;
    return { index, x: Math.round(8 + 6.5 * Math.cos(angle) - 1), y: Math.round(8 + 6.5 * Math.sin(angle) - 1), active: index < count };
  });
}

export function quotaFreshness(quota, now = Date.now() / 1000) {
  if (!quota?.h5 || !Number.isFinite(quota.h5.pct)) return 'unknown';
  if (!Number.isFinite(quota.updated) || now - quota.updated > QUOTA_STALE_SECONDS) return 'stale';
  return 'fresh';
}

export function quotaStatusText(quota, freshness = quotaFreshness(quota)) {
  if (freshness === 'unknown') return '5h usage unavailable';
  const reset = Number.isFinite(quota.h5?.resets) ? ` · resets at ${new Date(quota.h5.resets * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  return `${freshness === 'stale' ? 'Stale 5h usage' : '5h usage'} · ${Math.round(quota.h5.pct)}% used${reset}`;
}

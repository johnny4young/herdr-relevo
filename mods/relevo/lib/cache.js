// Small bounded Map helper to prevent unbounded memory growth in long-running views.

export function capMap(map, max = 200) {
  if (!map || map.size <= max) return map;
  const excess = map.size - max;
  let dropped = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++dropped >= excess) break;
  }
  return map;
}

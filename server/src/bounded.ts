/**
 * Insertion-ordered caches bounded by evicting the oldest entry.
 *
 * Wiping a whole cache when it reaches its limit is cheaper, but these caches
 * hold "already ledgered" / "already harvested" markers: a wipe re-admits
 * everything they were suppressing, so the memory bound turns into
 * double-charged cost and duplicated notebook entries. Evicting only the
 * oldest keeps the bound and keeps recent markers authoritative.
 */

/** Add to a set, evicting oldest insertions once over `max`. */
export function boundedSetAdd<T>(set: Set<T>, value: T, max: number): void {
  set.delete(value);
  set.add(value);
  evictOldest(set, max);
}

/** Set a map entry, evicting oldest insertions once over `max`. */
export function boundedMapSet<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  evictOldest(map, max);
}

function evictOldest(store: Set<unknown> | Map<unknown, unknown>, max: number): void {
  if (max <= 0) {
    store.clear();
    return;
  }
  while (store.size > max) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

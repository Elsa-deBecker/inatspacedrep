// Lookalike groups for the "Similar together" card order: new cards that people actually
// confuse with each other are introduced on the same day.
//
// Similarity comes only from iNat's misidentification data (identifications/similar_species),
// limited to the deck's place if it has one. For a pair A, B:
//   share(A→B) = how often A was confused with B / all of A's confusions
//   score(A, B) = √(share(A→B) × share(B→A))
// The geometric mean needs confusion in both directions, which filters out "default guess"
// effects (lots of ducks get called Mallards; Mallards rarely get called Wood Ducks).
//
// Groups are built by merging the strongest pairs first, and a card only joins a group if it
// is at least loosely similar to every member (so groups don't chain into one big blob).
// Nested cards (Anatini and Mallard) never count as similar, and cards without confusion
// data simply stay on their own.
'use strict';

const Similar = (() => {
  const TTL = 30 * 86400000;
  const STRONG = 0.05;   // a pair this similar starts or joins a group…
  const WEAK = 0.015;    // …as long as every cross pair is at least this similar
  const MIN_COUNT = 3;   // ignore confusions seen fewer times than this (noise)

  const key = (taxonId, placeId) => `sim.${taxonId}.${placeId || 0}`;
  const placeOf = deckId => {
    const d = Store.getDeck(deckId);
    return (d && d.filters && d.filters.place && d.filters.place.id) || 0;
  };

  // In-memory copy of the cached lists, so scheduling doesn't re-parse localStorage each time.
  const mem = new Map();
  function entry(taxonId, placeId) {
    const k = key(taxonId, placeId);
    if (!mem.has(k)) {
      const c = Store.getCache(k);
      if (!c) return null;
      const counts = new Map(c.list.map(x => [x.id, x.count]));
      let total = 0;
      for (const n of counts.values()) total += n;
      mem.set(k, { fetchedAt: c.fetchedAt, counts, total });
    }
    return mem.get(k);
  }

  /** Cards (from the list) whose lookalike data is missing or stale for this deck's place. */
  function missing(deckId, cards) {
    const place = placeOf(deckId);
    return cards.filter(c => { const e = entry(c.taxonId, place); return !e || Date.now() - e.fetchedAt > TTL; });
  }

  /**
   * Fetch missing lookalike data (one request per card, low priority). onProgress(done, total).
   * A card whose lookup fails is skipped (and retried next time); returns { fetched, failed }.
   */
  async function ensure(deckId, cards, onProgress = () => {}) {
    const place = placeOf(deckId);
    const todo = missing(deckId, cards);
    let failed = 0;
    for (let i = 0; i < todo.length; i++) {
      onProgress(i, todo.length);
      try {
        const list = await INat.similarSpecies(todo[i].taxonId, place);
        Store.setCache(key(todo[i].taxonId, place), { fetchedAt: Date.now(), list });
        mem.delete(key(todo[i].taxonId, place));
      } catch (e) { failed++; }
    }
    onProgress(todo.length, todo.length);
    return { fetched: todo.length - failed, failed };
  }

  function share(a, b, place) {
    const e = entry(a, place);
    if (!e || !e.total) return 0;
    const c = e.counts.get(b) || 0;
    return c >= MIN_COUNT ? c / e.total : 0;
  }

  const nested = (a, b) => {
    const ta = Store.getTaxon(a), tb = Store.getTaxon(b);
    return !!((ta && ta.ancestors && ta.ancestors.some(x => x.id === b)) ||
              (tb && tb.ancestors && tb.ancestors.some(x => x.id === a)));
  };

  function score(a, b, place) {
    if (a === b || nested(a, b)) return 0;
    return Math.sqrt(share(a, b, place) * share(b, a, place));
  }

  let memo = { sig: null, result: null };

  /** Partition taxon ids into lookalike groups (arrays of ids; singletons included). */
  function groups(deckId, taxonIds) {
    const place = placeOf(deckId);
    const ids = [...new Set(taxonIds)].sort((a, b) => a - b);
    // Recompute only when the cards, place or fetched data change.
    const stamp = ids.map(id => { const e = entry(id, place); return e ? e.fetchedAt : 0; }).join(',');
    const sig = `${deckId}|${place}|${ids.join(',')}|${stamp}`;
    if (memo.sig === sig) return memo.result;

    const inSet = new Set(ids);
    const pairs = [];
    const seen = new Set();
    for (const a of ids) {
      const e = entry(a, place);
      if (!e) continue;
      for (const b of e.counts.keys()) {
        if (!inSet.has(b)) continue;
        const k = a < b ? `${a}-${b}` : `${b}-${a}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const s = score(a, b, place);
        if (s >= STRONG) pairs.push([s, a, b]);
      }
    }
    pairs.sort((x, y) => y[0] - x[0]);
    const of = new Map(ids.map(id => [id, [id]]));
    for (const [, a, b] of pairs) {
      const A = of.get(a), B = of.get(b);
      if (A === B) continue;
      if (!A.every(x => B.every(y => score(x, y, place) >= WEAK))) continue;
      const M = [...A, ...B];
      for (const x of M) of.set(x, M);
    }
    const result = [...new Set(of.values())];
    memo = { sig, result };
    return result;
  }

  return { ensure, missing, groups, score, placeOf };
})();

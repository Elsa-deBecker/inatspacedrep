// Photo pools: for each taxon, a cached sample of eligible observations
// (research grade, allowed license, and — unless broadened — exactly one photo).
// Each review draws an observation the user hasn't seen yet for that taxon.
'use strict';

const Photos = (() => {
  const PER_PAGE = 200;
  const MAX_DEEP = 10000;        // iNat won't page past 10k results; use random sampling beyond
  const MAX_RANDOM_FETCHES = 25;
  const MAX_ITEMS = 250;         // cap per pool to keep localStorage small
  const TTL_MS = 30 * 86400000;  // refresh pools monthly
  const LOW_THRESHOLD = 10;

  const key = (taxonId, multi) => `pool.${taxonId}.${multi ? 'm' : 's'}`;

  function load(taxonId, multi) {
    const p = Store.getCache(key(taxonId, multi));
    if (p && Date.now() - p.createdAt < TTL_MS) return p;
    return { createdAt: Date.now(), total: null, pages: [], randomFetches: 0,
      complete: false, rejected: 0, accepted: 0, items: {} };
  }

  /** Compact pool item → keeps localStorage use low. */
  function extract(obs, multi) {
    if (!obs.photos || !obs.photos.length) return null;
    if (!multi && obs.photos.length !== 1) return null;
    const ph = obs.photos.find(p => INat.ALLOWED_LICENSES.includes(p.license_code));
    if (!ph) return null;
    return {
      o: obs.id,
      u: ph.url.replace('/square.', '/large.'),
      l: ph.license_code,
      a: ph.attribution,
      d: obs.observed_on || null,
      t: obs.taxon ? obs.taxon.id : null,
      n: obs.taxon ? obs.taxon.name : null,
      c: obs.taxon ? (obs.taxon.preferred_common_name || null) : null,
    };
  }

  const expand = i => ({ obsId: i.o, url: i.u, license: i.l, attribution: i.a, observedOn: i.d,
    taxon: i.t ? { id: i.t, name: i.n, commonName: i.c } : null });

  /** obsId → last time it was shown for this taxon (any deck). */
  function seenMap(taxonId) {
    const m = new Map();
    for (const r of Store.allReviews()) {
      if (r.taxonId === taxonId && r.obsId) m.set(r.obsId, Math.max(m.get(r.obsId) || 0, r.ts));
    }
    return m;
  }

  // Serialize pool growth per pool so background warming and live reviews don't collide.
  const locks = new Map();
  function withLock(k, fn) {
    const prev = locks.get(k) || Promise.resolve();
    const p = prev.then(fn, fn);
    locks.set(k, p.catch(() => {}));
    return p;
  }

  async function grow(taxonId, multi, p, seen) {
    let d;
    if (p.total === null || p.total > MAX_DEEP) {
      d = await INat.observations({ taxonId, perPage: PER_PAGE, random: true });
      p.randomFetches++;
    } else {
      const nPages = Math.ceil(p.total / PER_PAGE);
      const remaining = [];
      for (let i = 1; i <= nPages; i++) if (!p.pages.includes(i)) remaining.push(i);
      const page = remaining[Math.floor(Math.random() * remaining.length)];
      d = await INat.observations({ taxonId, perPage: PER_PAGE, page });
      p.pages.push(page);
    }
    p.total = d.total_results;
    for (const obs of d.results) {
      if (p.items[obs.id]) continue;
      const it = extract(obs, multi);
      if (it) { p.items[it.o] = it; p.accepted++; } else p.rejected++;
    }
    if (p.total <= PER_PAGE) p.complete = true;
    else if (p.total <= MAX_DEEP) p.complete = p.pages.length >= Math.ceil(p.total / PER_PAGE);
    else p.complete = p.randomFetches >= MAX_RANDOM_FETCHES;
    trim(p, seen);
    Store.setCache(key(taxonId, multi), p);
  }

  /** Keep pools bounded: drop already-seen items first, then random ones. */
  function trim(p, seen) {
    const ids = Object.keys(p.items);
    if (ids.length <= MAX_ITEMS) return;
    ids.sort((a, b) => (seen.has(+b) ? 1 : 0) - (seen.has(+a) ? 1 : 0) || Math.random() - 0.5);
    for (const id of ids.slice(0, ids.length - MAX_ITEMS)) delete p.items[id];
  }

  function info(p) {
    if (p.total === null) return null;
    const eligible = Object.keys(p.items).length;
    const sampled = p.accepted + p.rejected;
    const estimate = p.complete ? p.accepted
      : Math.round(p.total * (sampled ? p.accepted / sampled : 0));
    return { total: p.total, eligible, estimate, complete: p.complete, low: estimate < LOW_THRESHOLD };
  }

  /** Pool info from cache only (no network). */
  const cachedInfo = (taxonId, multi) => info(load(taxonId, multi));

  /**
   * Pick a photo for a taxon. Returns { photo, repeat, info } — photo null if none exist.
   * exclude: obsIds to avoid (e.g. one currently on screen).
   */
  function next(taxonId, opts = {}) {
    return withLock(key(taxonId, !!opts.multi), () => nextUnlocked(taxonId, opts));
  }

  /** Make sure a pool has at least its first sample (used to pre-load upcoming cards). */
  function warm(taxonId, multi = false) {
    return withLock(key(taxonId, multi), async () => {
      const p = load(taxonId, multi);
      if (p.total === null) await grow(taxonId, multi, p, seenMap(taxonId));
      return info(p);
    });
  }

  async function nextUnlocked(taxonId, { multi = false, exclude = new Set() } = {}) {
    const p = load(taxonId, multi);
    const seen = seenMap(taxonId);
    const usable = i => !Store.isBlocked(i.o) && !exclude.has(i.o);
    const fresh = () => Object.values(p.items).filter(i => usable(i) && !seen.has(i.o));

    let cands = fresh();
    for (let tries = 0; cands.length < 2 && !p.complete && tries < 3; tries++) {
      await grow(taxonId, multi, p, seen);
      cands = fresh();
    }
    if (p.total === null) await grow(taxonId, multi, p, seen);

    if (cands.length) {
      return { photo: expand(cands[Math.floor(Math.random() * cands.length)]), repeat: false, info: info(p) };
    }
    // Everything seen: reuse the least-recently-seen photo.
    const all = Object.values(p.items).filter(usable).sort((a, b) => (seen.get(a.o) || 0) - (seen.get(b.o) || 0));
    return { photo: all.length ? expand(all[0]) : null, repeat: all.length > 0, info: info(p) };
  }

  function preload(url) { const img = new Image(); img.src = url; }

  return { next, warm, cachedInfo, preload, LOW_THRESHOLD };
})();

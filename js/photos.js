// Photo pools: for each card, a cached sample of eligible observations
// (research grade, allowed license, and — unless broadened — exactly one photo),
// narrowed by the card's photo filters and same-deck exclusions.
// Each review draws an observation the user hasn't seen yet for that taxon.
//
// Functions take a `spec` from Filters.spec(deckId, card): { taxonId, multi, params, client, key }.
// The pool's cache key includes the filters, so changing them starts a fresh pool.
'use strict';

const Photos = (() => {
  const PER_PAGE = 200;
  const MAX_DEEP = 10000;        // iNat won't page past 10k results; use random sampling beyond
  const MAX_RANDOM_FETCHES = 25;
  const MAX_ITEMS = 250;         // cap per pool to keep localStorage small
  const TTL_MS = 30 * 86400000;  // refresh pools monthly
  const LOW_THRESHOLD = 10;

  function load(spec) {
    const p = Store.getCache(spec.key);
    if (p && Date.now() - p.createdAt < TTL_MS) return p;
    return { createdAt: Date.now(), total: null, pages: [], randomFetches: 0,
      complete: false, rejected: 0, accepted: 0, items: {} };
  }

  /** Compact pool item → keeps localStorage use low. */
  function extract(obs, spec, multi = spec.multi) {
    if (!obs.photos || !obs.photos.length) return null;
    if (!multi && obs.photos.length !== 1) return null;
    if (!Filters.passes(obs, spec.client)) return null;
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
      g: obs.location || null,                 // "lat,lng" (public; may be obscured)
      x: obs.obscured ? 1 : 0,
      r: obs.public_positional_accuracy || null, // meters
      p: obs.place_ids || [],
      s: between(obs.taxon, spec.taxonId),
    };
  }

  /** Ids of taxa strictly between the card's taxon and the observation's (e.g. the species of a subspecies). */
  function between(obsTaxon, cardTaxonId) {
    if (!obsTaxon || obsTaxon.id === cardTaxonId) return [];
    const anc = (obsTaxon.ancestor_ids || []).filter(id => id !== obsTaxon.id);
    const i = anc.indexOf(cardTaxonId);
    return i >= 0 ? anc.slice(i + 1) : [];
  }

  function expand(i) {
    let lat = null, lng = null;
    if (i.g) [lat, lng] = i.g.split(',').map(Number);
    return {
      obsId: i.o, url: i.u, license: i.l, attribution: i.a, observedOn: i.d,
      taxon: i.t ? { id: i.t, name: i.n, commonName: i.c } : null,
      lat, lng, obscured: !!i.x, accuracy: i.r, placeIds: i.p || [], between: i.s || [],
    };
  }

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

  async function grow(spec, p, seen) {
    const { taxonId, params: extra } = spec;
    let d;
    if (p.total === null || p.total > MAX_DEEP) {
      d = await INat.observations({ taxonId, perPage: PER_PAGE, random: true, extra });
      p.randomFetches++;
    } else {
      const nPages = Math.ceil(p.total / PER_PAGE);
      const remaining = [];
      for (let i = 1; i <= nPages; i++) if (!p.pages.includes(i)) remaining.push(i);
      const page = remaining[Math.floor(Math.random() * remaining.length)];
      d = await INat.observations({ taxonId, perPage: PER_PAGE, page, extra });
      p.pages.push(page);
    }
    p.total = d.total_results;
    for (const obs of d.results) {
      if (p.items[obs.id]) continue;
      const it = extract(obs, spec);
      if (it) { p.items[it.o] = it; p.accepted++; } else p.rejected++;
    }
    if (p.total <= PER_PAGE) p.complete = true;
    else if (p.total <= MAX_DEEP) p.complete = p.pages.length >= Math.ceil(p.total / PER_PAGE);
    else p.complete = p.randomFetches >= MAX_RANDOM_FETCHES;
    trim(p, seen);
    Store.setCache(spec.key, p);
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
  const cachedInfo = spec => info(load(spec));

  /**
   * Pick a photo for a taxon. Returns { photo, repeat, info } — photo null if none exist.
   * exclude: obsIds to avoid (e.g. one currently on screen).
   */
  function next(spec, opts = {}) {
    return withLock(spec.key, () => nextUnlocked(spec, opts));
  }

  /** Make sure a pool has at least its first sample (used to pre-load upcoming cards). */
  function warm(spec) {
    return withLock(spec.key, async () => {
      const p = load(spec);
      if (p.total === null) await grow(spec, p, seenMap(spec.taxonId));
      return info(p);
    });
  }

  async function nextUnlocked(spec, { exclude = new Set() } = {}) {
    const p = load(spec);
    const seen = seenMap(spec.taxonId);
    const usable = i => !Store.isBlocked(i.o) && !exclude.has(i.o);
    const fresh = () => Object.values(p.items).filter(i => usable(i) && !seen.has(i.o));

    let cands = fresh();
    for (let tries = 0; cands.length < 2 && !p.complete && tries < 3; tries++) {
      await grow(spec, p, seen);
      cands = fresh();
    }
    if (p.total === null) await grow(spec, p, seen);

    if (cands.length) {
      return { photo: expand(cands[Math.floor(Math.random() * cands.length)]), repeat: false, info: info(p) };
    }
    // Everything seen: reuse the least-recently-seen photo.
    const all = Object.values(p.items).filter(usable).sort((a, b) => (seen.get(a.o) || 0) - (seen.get(b.o) || 0));
    return { photo: all.length ? expand(all[0]) : null, repeat: all.length > 0, info: info(p) };
  }

  /** A specific observation's photo (e.g. to re-show one you missed). Null if unavailable/blocked. */
  async function byObs(spec, obsId) {
    if (Store.isBlocked(obsId)) return null;
    const p = Store.getCache(spec.key);
    if (p && p.items[obsId]) return expand(p.items[obsId]);
    const obs = await INat.observation(obsId);
    const it = obs && extract(obs, spec, true);
    return it ? expand(it) : null;
  }

  /** Start downloading an image; resolves when loaded (or failed). */
  const imageCache = new Map();
  function preload(url) {
    if (imageCache.has(url)) return imageCache.get(url).promise;
    const img = new Image();
    const promise = new Promise(res => { img.onload = () => res(true); img.onerror = () => res(false); });
    img.src = url;
    imageCache.set(url, { img, promise });
    if (imageCache.size > 30) imageCache.delete(imageCache.keys().next().value);
    return promise;
  }
  const isLoaded = url => { const e = imageCache.get(url); return !!(e && e.img.complete && e.img.naturalWidth); };

  return { next, warm, byObs, cachedInfo, preload, isLoaded, LOW_THRESHOLD };
})();

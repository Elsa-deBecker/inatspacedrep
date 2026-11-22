// Thin iNaturalist API client with a polite rate limit (iNat asks for ≤ ~1 req/sec).
'use strict';

const INat = (() => {
  const V1 = 'https://api.inaturalist.org/v1';
  const V2 = 'https://api.inaturalist.org/v2';
  const MIN_GAP_MS = 1000;
  const ALLOWED_LICENSES = ['cc0', 'cc-by', 'cc-by-nc'];

  let lastAt = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function fetchWithRetry(url) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try { res = await fetch(url); }
      catch (e) {
        if (attempt >= 2) throw new Error('Network error talking to iNaturalist.');
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (res.ok) return res.json();
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(3000 * (attempt + 1));
        continue;
      }
      throw new Error(`iNaturalist API error ${res.status}`);
    }
  }

  // All requests go through one queue with a minimum gap between starts. Requests the user is
  // actively waiting on (searches, name lookups) jump ahead of background ones (photo pools,
  // maps), but the overall rate never exceeds iNat's limit.
  const queues = { high: [], low: [] };
  let pumping = false;

  function get(url, { priority = false } = {}) {
    return new Promise((resolve, reject) => {
      queues[priority ? 'high' : 'low'].push({ url, resolve, reject });
      pump();
    });
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const job = queues.high.shift() || queues.low.shift();
        if (!job) break;
        const wait = lastAt + MIN_GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
        lastAt = Date.now();
        try { job.resolve(await fetchWithRetry(job.url)); } catch (e) { job.reject(e); }
      }
    } finally { pumping = false; }
  }
  const hi = { priority: true };

  const qs = params => Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  const locale = () => Store.getSettings().locale || 'en';

  // ---------- taxa ----------
  const autocompleteTaxa = q =>
    get(`${V1}/taxa/autocomplete?${qs({ q, per_page: 10, locale: locale() })}`, hi).then(d => d.results);

  const searchTaxa = q =>
    get(`${V1}/taxa?${qs({ q, per_page: 5, is_active: true, locale: locale() })}`, hi).then(d => d.results);

  /** Full taxon records (with all names) normalized for our cache. */
  async function fetchTaxa(ids, { priority = true } = {}) {
    const out = [];
    for (let i = 0; i < ids.length; i += 30) {
      const chunk = ids.slice(i, i + 30);
      const d = await get(`${V1}/taxa/${chunk.join(',')}?${qs({ all_names: true, locale: locale() })}`, { priority });
      out.push(...d.results.map(normalizeTaxon));
    }
    return out;
  }

  function normalizeTaxon(t) {
    const loc = locale();
    const names = (t.names || [])
      .filter(n => n.locale === 'sci' || n.locale === loc)
      .map(n => n.name);
    if (!names.includes(t.name)) names.unshift(t.name);
    const sciNames = [t.name, ...(t.names || []).filter(n => n.locale === 'sci' && n.name !== t.name).map(n => n.name)];
    if (t.preferred_common_name && !names.includes(t.preferred_common_name)) names.push(t.preferred_common_name);
    const anc = {};
    for (const a of t.ancestors || []) anc[a.rank] = a.name;
    return {
      id: t.id, name: t.name, rank: t.rank, rankLevel: t.rank_level,
      commonName: t.preferred_common_name || null,
      iconic: t.iconic_taxon_name || null,
      family: anc.family || null, order: anc.order || null,
      thumb: t.default_photo ? t.default_photo.square_url : null,
      names, sciNames, fetchedAt: Date.now(),
      // Root → parent. Used to find which deck cards fall inside which, and to recognize an
      // answer that's correct but too general ("Anas" on a Mallard card).
      ancestors: (t.ancestors || []).filter(a => a.id !== t.id).map(a => ({
        id: a.id, name: a.name, rank: a.rank, commonName: a.preferred_common_name || null })),
    };
  }

  /** Lat/lng bounding box of all verifiable observations of a taxon (for the answer map). */
  async function taxonBounds(taxonId) {
    const d = await get(`${V1}/observations?${qs({ taxon_id: taxonId, verifiable: true, return_bounds: true, per_page: 0 })}`);
    return d.total_bounds || null;
  }

  // ---------- places ----------
  const autocompletePlaces = q =>
    get(`${V1}/places/autocomplete?${qs({ q, per_page: 10 })}`, hi).then(d => d.results);

  /** Of the given place ids, the standard places at an admin level (0 = country, 10 = state/province). */
  async function placesAtLevel(ids, adminLevel) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const d = await get(`${V1}/places/${ids.slice(i, i + 100).join(',')}?${qs({ admin_level: adminLevel })}`);
      out.push(...d.results);
    }
    return out;
  }

  // ---------- deck generation ----------
  /** params: extra observation-search params (place, months, dates, annotation) from Filters. */
  async function speciesCounts({ taxonId, count, params = {} }) {
    const d = await get(`${V1}/observations/species_counts?${qs(Object.assign({}, params, {
      taxon_id: taxonId, quality_grade: 'research',
      per_page: Math.min(500, count * 2), locale: locale(),
    }))}`, hi);
    return d.results.filter(r => r.taxon.rank === 'species').slice(0, count);
  }

  // ---------- observations (photo pools) ----------
  const OBS_FIELDS = '(id:!t,observed_on:!t,place_guess:!t,user:(login:!t,name:!t),' +
    'location:!t,obscured:!t,public_positional_accuracy:!t,place_ids:!t,' +
    'photos:(id:!t,url:!t,license_code:!t,attribution:!t),' +
    'annotations:(controlled_attribute_id:!t,controlled_value_id:!t,vote_score:!t),' +
    'taxon:(id:!t,name:!t,rank:!t,preferred_common_name:!t,ancestor_ids:!t))';

  /**
   * One page of research-grade observations with an allowed-license photo.
   * extra: additional iNat observation-search params (future filters plug in here).
   */
  function observations({ taxonId, page = 1, perPage = 200, random = false, extra = {} }) {
    return get(`${V2}/observations?${qs(Object.assign({
      taxon_id: taxonId, quality_grade: 'research', photos: true,
      photo_license: ALLOWED_LICENSES.join(','),
      per_page: perPage, page: random ? 1 : page,
      order_by: random ? 'random' : undefined,
      locale: locale(), fields: OBS_FIELDS,
    }, extra))}`);
  }

  /** A single observation by id (same fields as pool fetches), or null. */
  async function observation(id) {
    const d = await get(`${V2}/observations?${qs({ id, fields: OBS_FIELDS, locale: locale() })}`);
    return d.results[0] || null;
  }

  // ---------- lookalikes ----------
  /**
   * Taxa that observations of this taxon were misidentified as (or vice versa), with counts,
   * optionally within a place. iNat returns roughly the top 24, at the taxon's own rank.
   */
  async function similarSpecies(taxonId, placeId) {
    const d = await get(`${V1}/identifications/similar_species?${qs({ taxon_id: taxonId, place_id: placeId || undefined, quality_grade: 'research' })}`);
    return d.results.map(r => ({ id: r.taxon.id, count: r.count }));
  }

  // ---------- annotations ----------
  /** iNat's annotation vocabulary, normalized: [{ id, label, taxonIds, exceptIds, values: [{ id, label, taxonIds }] }] */
  async function controlledTerms() {
    const d = await get(`${V1}/controlled_terms`, hi);
    return d.results.map(t => ({
      id: t.id, label: t.label, taxonIds: t.taxon_ids || null, exceptIds: t.excepted_taxon_ids || null,
      values: (t.values || []).map(v => ({ id: v.id, label: v.label, taxonIds: v.taxon_ids || null })),
    }));
  }

  return { similarSpecies, controlledTerms, autocompleteTaxa, searchTaxa, fetchTaxa, taxonBounds, autocompletePlaces, placesAtLevel,
    speciesCounts, observations, observation, ALLOWED_LICENSES };
})();

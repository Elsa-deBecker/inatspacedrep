// Thin iNaturalist API client with a polite rate limit (iNat asks for ≤ ~1 req/sec).
'use strict';

const INat = (() => {
  const V1 = 'https://api.inaturalist.org/v1';
  const V2 = 'https://api.inaturalist.org/v2';
  const MIN_GAP_MS = 1000;
  const ALLOWED_LICENSES = ['cc0', 'cc-by', 'cc-by-nc'];

  let lastAt = 0;
  let chain = Promise.resolve();
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

  /** All requests are serialized through one queue with a minimum gap. */
  function get(url) {
    const p = chain.then(async () => {
      const wait = lastAt + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      return fetchWithRetry(url);
    });
    chain = p.catch(() => {});
    return p;
  }

  const qs = params => Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

  const locale = () => Store.getSettings().locale || 'en';

  // ---------- taxa ----------
  const autocompleteTaxa = q =>
    get(`${V1}/taxa/autocomplete?${qs({ q, per_page: 10, locale: locale() })}`).then(d => d.results);

  const searchTaxa = q =>
    get(`${V1}/taxa?${qs({ q, per_page: 5, is_active: true, locale: locale() })}`).then(d => d.results);

  /** Full taxon records (with all names) normalized for our cache. */
  async function fetchTaxa(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 30) {
      const chunk = ids.slice(i, i + 30);
      const d = await get(`${V1}/taxa/${chunk.join(',')}?${qs({ all_names: true, locale: locale() })}`);
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
    };
  }

  /** Lat/lng bounding box of all verifiable observations of a taxon (for the answer map). */
  async function taxonBounds(taxonId) {
    const d = await get(`${V1}/observations?${qs({ taxon_id: taxonId, verifiable: true, return_bounds: true, per_page: 0 })}`);
    return d.total_bounds || null;
  }

  // ---------- places ----------
  const autocompletePlaces = q =>
    get(`${V1}/places/autocomplete?${qs({ q, per_page: 10 })}`).then(d => d.results);

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
  async function speciesCounts({ taxonId, placeId, count }) {
    const d = await get(`${V1}/observations/species_counts?${qs({
      taxon_id: taxonId, place_id: placeId, quality_grade: 'research',
      per_page: Math.min(500, count * 2), locale: locale(),
    })}`);
    return d.results.filter(r => r.taxon.rank === 'species').slice(0, count);
  }

  // ---------- observations (photo pools) ----------
  const OBS_FIELDS = '(id:!t,observed_on:!t,place_guess:!t,user:(login:!t,name:!t),' +
    'location:!t,obscured:!t,public_positional_accuracy:!t,place_ids:!t,' +
    'photos:(id:!t,url:!t,license_code:!t,attribution:!t),' +
    'taxon:(id:!t,name:!t,rank:!t,preferred_common_name:!t))';

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

  return { autocompleteTaxa, searchTaxa, fetchTaxa, taxonBounds, autocompletePlaces, placesAtLevel,
    speciesCounts, observations, observation, ALLOWED_LICENSES };
})();

// Photo filters: which observations a card draws its photos from.
//
// A filter object (stored on decks as `deck.filters` and on cards as `card.filters`):
//   { place:  { id, name } | null,
//     annos:  [{ term, value, not, label }]   annotation conditions ("is" / "is not")
//     months: { from, to } | null              1–12, may wrap around the new year (11 → 2)
//     d1, d2: 'YYYY-MM-DD' | null              observed-on date range
//     // card only:
//     noDeckPlace:   true → ignore the deck's place
//     noDeckFilters: true → ignore the deck's annotations, months and dates }
//
// A card's effective filters = the deck's, with the card's added on top: the card's place,
// months and dates replace the deck's; annotations from both apply.
//
// On top of that, a card automatically excludes every other card in the same deck that
// falls inside it (an Anatini card never shows Mallards if Mallard has its own card).
'use strict';

const Filters = (() => {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** Normalized copy with empty parts removed; null if nothing is set. */
  function clean(f) {
    if (!f) return null;
    const out = {};
    if (f.place && f.place.id) out.place = { id: f.place.id, name: f.place.name || `Place ${f.place.id}` };
    const annos = (f.annos || []).filter(a => a && a.term && a.value)
      .map(a => ({ term: +a.term, value: +a.value, not: !!a.not, label: a.label || '' }));
    if (annos.length) out.annos = annos;
    if (f.months && f.months.from && f.months.to) out.months = { from: +f.months.from, to: +f.months.to };
    if (f.d1) out.d1 = f.d1;
    if (f.d2) out.d2 = f.d2;
    if (f.noDeckPlace) out.noDeckPlace = true;
    if (f.noDeckFilters) out.noDeckFilters = true;
    return Object.keys(out).length ? out : null;
  }

  const same = (a, b) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));

  function combine(deckF, cardF) {
    const d = clean(deckF) || {}, c = clean(cardF) || {};
    const deckOther = c.noDeckFilters ? {} : d;
    const annos = [];
    for (const a of [...(deckOther.annos || []), ...(c.annos || [])]) {
      if (!annos.some(x => x.term === a.term && x.value === a.value && x.not === a.not)) annos.push(a);
    }
    return clean({
      place: c.place || (c.noDeckPlace ? null : d.place),
      annos,
      months: c.months || deckOther.months,
      d1: c.d1 || deckOther.d1,
      d2: c.d2 || deckOther.d2,
    }) || {};
  }

  function monthList({ from, to }) {
    const out = [];
    for (let m = from; ; m = m % 12 + 1) { out.push(m); if (m === to || out.length >= 12) break; }
    return out;
  }

  /** iNat search params for the server, and annotation checks the app must apply itself. */
  function query(eff, excludeIds = []) {
    const params = {};
    if (eff.place) params.place_id = eff.place.id;
    if (eff.months) params.month = monthList(eff.months).join(',');
    if (eff.d1) params.d1 = eff.d1;
    if (eff.d2) params.d2 = eff.d2;
    if (excludeIds.length) params.without_taxon_id = excludeIds.join(',');
    // iNat accepts one annotation term per query, and its "without" filter drops unannotated
    // observations. So: the first "is" goes to the server, everything else is checked locally.
    const client = [];
    for (const a of eff.annos || []) {
      if (!a.not && params.term_id === undefined) { params.term_id = a.term; params.term_value_id = a.value; }
      else client.push({ term: a.term, value: a.value, not: a.not });
    }
    return { params, client };
  }

  /** Does an observation (with `annotations`) pass the locally-applied annotation checks? */
  function passes(obs, client) {
    if (!client || !client.length) return true;
    const has = (term, value) => (obs.annotations || []).some(a =>
      a.controlled_attribute_id === term && a.controlled_value_id === value && (a.vote_score ?? 0) >= 0);
    return client.every(c => has(c.term, c.value) !== c.not);
  }

  /** Other active cards in the deck that fall inside this card's taxon. */
  function excludedCards(deckId, taxonId) {
    const out = [];
    for (const c of Store.deckCards(deckId)) {
      if (c.taxonId === taxonId) continue;
      const t = Store.getTaxon(c.taxonId);
      if (t && t.ancestors && t.ancestors.some(a => a.id === taxonId)) out.push(c.taxonId);
    }
    return out.sort((a, b) => a - b);
  }

  // Short stable hash for cache keys.
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /**
   * Everything the photo layer needs for one card:
   * { taxonId, multi, params, client, key, eff, excluded }
   */
  function spec(deckId, card) {
    const deck = Store.getDeck(deckId);
    const eff = combine(deck && deck.filters, card.filters);
    const excluded = excludedCards(deckId, card.taxonId);
    const { params, client } = query(eff, excluded);
    const multi = !!card.allowMultiPhoto;
    const sig = Object.keys(params).length || client.length ? '.' + hash(JSON.stringify([params, client])) : '';
    return { taxonId: card.taxonId, multi, params, client, eff, excluded,
      key: `pool3.${card.taxonId}.${multi ? 'm' : 's'}${sig}` };
  }

  // ---------- human-readable summaries ----------
  function parts(f) {
    f = clean(f) || {};
    const out = [];
    if (f.place) out.push(f.place.name);
    for (const a of f.annos || []) out.push((a.not ? 'not ' : '') + (a.label || `annotation ${a.term}=${a.value}`));
    if (f.months) out.push(f.months.from === f.months.to ? MONTHS[f.months.from - 1]
      : `${MONTHS[f.months.from - 1]}–${MONTHS[f.months.to - 1]}`);
    if (f.d1 && f.d2) out.push(`${f.d1} to ${f.d2}`);
    else if (f.d1) out.push(`from ${f.d1}`);
    else if (f.d2) out.push(`until ${f.d2}`);
    return out;
  }
  const summary = f => parts(f).join(' · ');

  const taxonLabel = id => {
    const t = Store.getTaxon(id);
    return t ? (t.commonName || t.name) : `taxon ${id}`;
  };

  // ---------- annotation vocabulary (iNat "controlled terms") ----------
  const TERMS_KEY = 'terms.v1';
  const TERMS_TTL = 30 * 86400000;
  let termsPromise = null;

  function terms() {
    const c = Store.getCache(TERMS_KEY);
    if (c && Date.now() - c.fetchedAt < TERMS_TTL) return Promise.resolve(c.list);
    if (!termsPromise) {
      termsPromise = INat.controlledTerms().then(list => {
        Store.setCache(TERMS_KEY, { fetchedAt: Date.now(), list });
        return list;
      }).catch(e => { termsPromise = null; if (c) return c.list; throw e; });
    }
    return termsPromise;
  }

  /** Terms/values that apply to a taxon (given its id + ancestor ids); all of them if ids is null. */
  function applicable(list, ids) {
    if (!ids) return list;
    const A = new Set(ids);
    const hit = arr => !arr || !arr.length || arr.some(id => A.has(id));
    return list
      .filter(t => hit(t.taxonIds) && !(t.exceptIds || []).some(id => A.has(id)))
      .map(t => Object.assign({}, t, { values: t.values.filter(v => hit(v.taxonIds)) }))
      .filter(t => t.values.length);
  }

  return { MONTHS, clean, same, combine, query, passes, excludedCards, spec,
    summary, parts, taxonLabel, terms, applicable };
})();

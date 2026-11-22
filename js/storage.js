// Storage layer. EVERYTHING the app persists goes through this module, so that
// swapping localStorage for a sync backend later only means changing this file.
//
// Data model (designed to merge cleanly across devices):
//   decks:    { [deckId]: { id, name, mode, newPerDay, updatedAt, deleted?, filters?,
//                           cards: { [taxonId]: { addedAt, updatedAt, removed?, allowMultiPhoto?, filters? } } } }
//             (filters: photo filters, see filters.js)
//             → merged last-write-wins per deck field-group and per card.
//   reviews:  append-only log [{ id, deckId, taxonId, ts, grade, obsId, mode }]
//             → merged by union on id. Card schedules are DERIVED from this log.
//   blocked:  { [obsId]: { ts } }  photos the user flagged as unusable (union-merged)
//   taxa:     { [taxonId]: taxon metadata } — a cache of iNat data, refetchable
//   settings: { locale, updatedAt }
// Photo pools (big, purely a cache) are kept under separate keys and never exported.
'use strict';

const Store = (() => {
  const KEY = 'inatsr.data.v1';
  const CACHE_PREFIX = 'inatsr.cache.';
  const listeners = new Set();

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2));

  function emptyData() {
    return { version: 1, decks: {}, reviews: [], blocked: {}, taxa: {},
      settings: { locale: 'en', updatedAt: 0 } };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return Object.assign(emptyData(), JSON.parse(raw));
    } catch (e) { console.error('Failed to load data', e); }
    return emptyData();
  }

  let data = load();

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      // Quota: drop photo-pool caches (they're refetchable) and retry once.
      clearPhotoCaches();
      localStorage.setItem(KEY, JSON.stringify(data));
    }
    listeners.forEach(fn => fn());
  }

  // ---------- decks & cards ----------
  function listDecks() {
    return Object.values(data.decks).filter(d => !d.deleted)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const getDeck = id => (data.decks[id] && !data.decks[id].deleted) ? data.decks[id] : null;

  function createDeck(name) {
    const now = Date.now();
    const deck = { id: uuid(), name, mode: 'self', newPerDay: 20, showMap: true, order: 'random',
      createdAt: now, updatedAt: now, cards: {} };
    data.decks[deck.id] = deck;
    save();
    return deck;
  }

  function updateDeck(id, patch) {
    const d = data.decks[id];
    Object.assign(d, patch, { updatedAt: Date.now() });
    save();
  }

  const deleteDeck = id => updateDeck(id, { deleted: true });

  /** Active (non-removed) card entries of a deck as [{taxonId, ...entry}]. */
  function deckCards(deckId) {
    const d = getDeck(deckId);
    if (!d) return [];
    return Object.entries(d.cards).filter(([, c]) => !c.removed)
      .map(([taxonId, c]) => Object.assign({ taxonId: Number(taxonId) }, c));
  }

  /**
   * Add cards with the given photo filters. Taxa already in the deck are left alone; those whose
   * current filters differ are returned as `conflicts` so the UI can ask what to do.
   */
  function addCards(deckId, taxonIds, filters = null) {
    const d = data.decks[deckId];
    const now = Date.now();
    let added = 0;
    const conflicts = [];
    for (const id of taxonIds) {
      const c = d.cards[id];
      if (c && !c.removed) {
        if (!Filters.same(c.filters, filters)) conflicts.push(Number(id));
        continue;
      }
      d.cards[id] = { addedAt: now, updatedAt: now, allowMultiPhoto: c ? !!c.allowMultiPhoto : false };
      if (Filters.clean(filters)) d.cards[id].filters = Filters.clean(filters);
      added++;
    }
    if (added) save();
    return { added, conflicts };
  }

  function updateCard(deckId, taxonId, patch) {
    const c = data.decks[deckId].cards[taxonId];
    Object.assign(c, patch, { updatedAt: Date.now() });
    save();
  }
  const removeCard = (deckId, taxonId) => updateCard(deckId, taxonId, { removed: true });

  // ---------- reviews ----------
  function addReview(r) {
    const rec = Object.assign({ id: uuid(), ts: Date.now() }, r);
    data.reviews.push(rec);
    save();
    return rec;
  }
  const reviewsFor = deckId => data.reviews.filter(r => r.deckId === deckId);
  const allReviews = () => data.reviews;

  // ---------- blocked photos ----------
  function blockObservation(obsId) { data.blocked[obsId] = { ts: Date.now() }; save(); }
  const isBlocked = obsId => !!data.blocked[obsId];

  // ---------- taxa cache ----------
  const getTaxon = id => data.taxa[id] || null;
  const allTaxa = () => Object.values(data.taxa);
  function putTaxa(list) { for (const t of list) data.taxa[t.id] = t; save(); }

  // ---------- settings ----------
  const getSettings = () => data.settings;
  function updateSettings(patch) { Object.assign(data.settings, patch, { updatedAt: Date.now() }); save(); }

  // ---------- photo pool cache (not synced) ----------
  function getCache(key) {
    try { const raw = localStorage.getItem(CACHE_PREFIX + key); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  }
  function setCache(key, value) {
    try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value)); }
    catch (e) {
      clearPhotoCaches();
      try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value)); } catch { /* give up quietly */ }
    }
  }
  function clearPhotoCaches(prefix = '') {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX + prefix)) localStorage.removeItem(k);
    }
  }
  // Drop pools in older formats ("pool." lacked locations, "pool2." lacked filters and
  // the ancestry needed to accept more-specific answers). They're refetched as needed.
  try { clearPhotoCaches('pool.'); clearPhotoCaches('pool2.'); } catch { /* ignore */ }

  // ---------- export / import / merge ----------
  function exportJSON() {
    return JSON.stringify(Object.assign({ exportedAt: new Date().toISOString() }, data), null, 1);
  }

  /** Merge another device's export into ours. Safe to run repeatedly. */
  function mergeJSON(text) {
    const other = JSON.parse(text);
    if (!other || other.version !== 1) throw new Error('Not a recognized export file.');
    const stats = { decks: 0, reviews: 0 };

    for (const [id, od] of Object.entries(other.decks || {})) {
      const mine = data.decks[id];
      if (!mine) { data.decks[id] = od; stats.decks++; continue; }
      const cards = Object.assign({}, mine.cards);
      for (const [tid, oc] of Object.entries(od.cards || {})) {
        if (!cards[tid] || (oc.updatedAt || 0) > (cards[tid].updatedAt || 0)) cards[tid] = oc;
      }
      const winner = (od.updatedAt || 0) > (mine.updatedAt || 0) ? od : mine;
      data.decks[id] = Object.assign({}, winner, { cards });
    }

    const have = new Set(data.reviews.map(r => r.id));
    for (const r of other.reviews || []) {
      if (!have.has(r.id)) { data.reviews.push(r); stats.reviews++; }
    }
    data.reviews.sort((a, b) => a.ts - b.ts);

    Object.assign(data.blocked, other.blocked || {});
    for (const [id, t] of Object.entries(other.taxa || {})) {
      if (!data.taxa[id] || (t.fetchedAt || 0) > (data.taxa[id].fetchedAt || 0)) data.taxa[id] = t;
    }
    if ((other.settings?.updatedAt || 0) > (data.settings.updatedAt || 0)) data.settings = other.settings;
    save();
    return stats;
  }

  const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };

  return {
    listDecks, getDeck, createDeck, updateDeck, deleteDeck,
    deckCards, addCards, updateCard, removeCard,
    addReview, reviewsFor, allReviews,
    blockObservation, isBlocked,
    getTaxon, allTaxa, putTaxa, getSettings, updateSettings,
    getCache, setCache, clearPhotoCaches,
    exportJSON, mergeJSON, onChange,
  };
})();

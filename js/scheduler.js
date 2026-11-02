// Derives card schedules from the review log and decides what to show next.
'use strict';

const Scheduler = (() => {
  const LEARN_AHEAD_MS = 20 * 60 * 1000;

  /** taxonId → FSRS state (plus firstTs), replayed from the deck's review log. */
  function states(deckId) {
    const map = new Map();
    const revs = Store.reviewsFor(deckId).slice().sort((a, b) => a.ts - b.ts);
    for (const r of revs) {
      const prev = map.get(r.taxonId) || null;
      const next = FSRS.review(prev, r.grade, r.ts);
      next.firstTs = prev ? prev.firstTs : r.ts;
      map.set(r.taxonId, next);
    }
    return map;
  }

  function summary(deckId, now = Date.now()) {
    const deck = Store.getDeck(deckId);
    const cards = Store.deckCards(deckId).sort((a, b) => a.addedAt - b.addedAt || a.taxonId - b.taxonId);
    const st = states(deckId);
    const today = FSRS.dayStart(now);
    let introducedToday = 0;
    for (const s of st.values()) if (s.firstTs >= today) introducedToday++;

    const due = [], soon = [], fresh = [];
    for (const c of cards) {
      const s = st.get(c.taxonId);
      if (!s) fresh.push(c);
      else if (s.due <= now) due.push(Object.assign({ state: s }, c));
      else if (s.phase === 'learning' && s.due <= now + LEARN_AHEAD_MS) soon.push(Object.assign({ state: s }, c));
    }
    due.sort((a, b) => a.state.due - b.state.due);
    soon.sort((a, b) => a.state.due - b.state.due);
    const newLeft = Math.min(fresh.length, Math.max(0, (deck ? deck.newPerDay : 20) - introducedToday));
    return { due, soon, fresh, newLeft, states: st, total: cards.length };
  }

  /**
   * Next card to study, or null.
   * avoid: taxonId just shown (not repeated back-to-back if there's an alternative).
   * skip: Set of taxonIds to leave out for this session.
   */
  function nextCard(deckId, { avoid: avoidTaxonId = null, skip = new Set() } = {}, now = Date.now()) {
    const s = summary(deckId, now);
    const keep = c => !skip.has(c.taxonId);
    s.due = s.due.filter(keep); s.soon = s.soon.filter(keep);
    const freshAvail = s.fresh.filter(keep).slice(0, s.newLeft);
    let lists;
    if (s.due.length && freshAvail.length) {
      // Mix new cards in among reviews proportionally.
      const pNew = freshAvail.length / (freshAvail.length + s.due.length);
      lists = Math.random() < pNew ? [freshAvail, s.due] : [s.due, freshAvail];
    } else {
      lists = [s.due, freshAvail].filter(l => l.length);
    }
    if (!lists.length && s.soon.length) lists = [s.soon];
    for (const l of lists) {
      const c = l.find(x => x.taxonId !== avoidTaxonId);
      if (c) return c;
    }
    return lists.length ? lists[0][0] : null;
  }

  /** For each grade, a label of when the card would be due next. */
  function preview(deckId, taxonId, now = Date.now()) {
    const st = states(deckId).get(taxonId) || null;
    return [1, 2, 3, 4].map(g => FSRS.formatDelay(FSRS.review(st, g, now).due, now));
  }

  return { states, summary, nextCard, preview };
})();

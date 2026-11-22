// Derives card schedules from the review log and decides what to show next.
'use strict';

const Scheduler = (() => {
  const LEARN_AHEAD_MS = 20 * 60 * 1000;

  /** taxonId → FSRS state (plus firstTs, lastReview), replayed from the deck's review log. */
  function states(deckId) {
    const map = new Map();
    const revs = Store.reviewsFor(deckId).slice().sort((a, b) => a.ts - b.ts);
    for (const r of revs) {
      const prev = map.get(r.taxonId) || null;
      const next = FSRS.review(prev, r.grade, r.ts);
      next.firstTs = prev ? prev.firstTs : r.ts;
      next.lastReview = r;
      map.set(r.taxonId, next);
    }
    return map;
  }

  /** Deterministic pseudo-random rank: shuffles cards differently each day, but stably within a day. */
  function dailyRank(taxonId, day) {
    let h = (taxonId * 2654435761 ^ Math.floor(day / 3600000)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  const SIMILAR_SLACK = 4; // a day's new cards may land this far over or under the limit

  /**
   * "Similar together": order new cards in lookalike groups and decide how many to introduce
   * today. A group started today is always finished. Other groups are added whole, in daily
   * random order, until the day reaches the limit, skipping groups that would overshoot by more
   * than SIMILAR_SLACK. If that leaves the day more than SIMILAR_SLACK short, the group that
   * lands closest to the limit is added. Returns { fresh, newLeft, groupOf }.
   */
  function planSimilar(deckId, cards, st, today, limit, rank) {
    const introducedToday = cards.filter(c => { const s = st.get(c.taxonId); return s && s.firstTs >= today; });
    const freshCards = cards.filter(c => !st.get(c.taxonId));
    const byId = new Map(cards.map(c => [c.taxonId, c]));
    const startedToday = new Set(introducedToday.map(c => c.taxonId));
    const groups = Similar.groups(deckId, [...introducedToday, ...freshCards].map(c => c.taxonId));

    const groupOf = new Map();
    const mandatory = [], open = [];
    for (const g of groups) {
      for (const id of g) groupOf.set(id, g);
      const freshPart = g.filter(id => !st.get(id)).map(id => byId.get(id)).sort((a, b) => rank(a) - rank(b));
      if (!freshPart.length) continue;
      (g.some(id => startedToday.has(id)) ? mandatory : open).push(freshPart);
    }
    open.sort((a, b) => rank(a[0]) - rank(b[0]));

    let total = introducedToday.length + mandatory.reduce((n, g) => n + g.length, 0);
    const chosen = new Set();
    if (limit > 0) {
      for (const g of open) {
        if (total >= limit) break;
        if (total + g.length <= limit + SIMILAR_SLACK) { chosen.add(g); total += g.length; }
      }
      const rest = open.filter(g => !chosen.has(g));
      if (rest.length && (total < limit - SIMILAR_SLACK || total === 0)) {
        const best = rest.reduce((b, g) => Math.abs(total + g.length - limit) < Math.abs(total + b.length - limit) ? g : b);
        // Take it if it brings the day closer to the limit, or if nothing would be introduced otherwise.
        if (Math.abs(total + best.length - limit) < limit - total || total === 0) chosen.add(best);
      }
    }
    const today_ = [...mandatory.flat(), ...open.filter(g => chosen.has(g)).flat()];
    const later = open.filter(g => !chosen.has(g)).flat();
    return { fresh: [...today_, ...later], newLeft: today_.length, groupOf };
  }

  function summary(deckId, now = Date.now()) {
    const deck = Store.getDeck(deckId);
    const random = !deck || deck.order !== 'added';
    const today = FSRS.dayStart(now);
    const rank = c => dailyRank(c.taxonId, today);
    const cards = Store.deckCards(deckId);
    const st = states(deckId);
    let introducedToday = 0;
    for (const s of st.values()) if (s.firstTs >= today) introducedToday++;

    const learning = [], due = [], soon = [], fresh = [];
    for (const c of cards) {
      const s = st.get(c.taxonId);
      if (!s) fresh.push(c);
      else if (s.due <= now) (s.phase === 'learning' ? learning : due).push(Object.assign({ state: s }, c));
      else if (s.phase === 'learning' && s.due <= now + LEARN_AHEAD_MS) soon.push(Object.assign({ state: s }, c));
    }
    learning.sort((a, b) => a.state.due - b.state.due);
    soon.sort((a, b) => a.state.due - b.state.due);
    if (random) {
      due.sort((a, b) => rank(a) - rank(b));
      fresh.sort((a, b) => rank(a) - rank(b));
    } else {
      due.sort((a, b) => a.state.due - b.state.due);
      fresh.sort((a, b) => a.addedAt - b.addedAt || a.taxonId - b.taxonId);
    }
    const limit = deck ? deck.newPerDay : 20;
    let newLeft = Math.min(fresh.length, Math.max(0, limit - introducedToday));
    let freshOrdered = fresh, groupOf = null;
    if (deck && deck.order === 'similar') {
      ({ fresh: freshOrdered, newLeft, groupOf } = planSimilar(deckId, cards, st, today, limit, rank));
    }
    // `due` in the returned summary includes learning cards (they come first).
    return { due: [...learning, ...due], learning, reviews: due, soon, fresh: freshOrdered, newLeft, groupOf,
      states: st, total: cards.length };
  }

  /**
   * Next card to study, or null.
   * avoid: taxonId just shown (not repeated back-to-back if there's an alternative).
   * skip: Set of taxonIds to leave out for this session.
   */
  function nextCard(deckId, { avoid = null, skip = new Set() } = {}, now = Date.now()) {
    const s = summary(deckId, now);
    const keep = c => !skip.has(c.taxonId);
    const learning = s.learning.filter(keep);
    const reviews = s.reviews.filter(keep);
    const soon = s.soon.filter(keep);
    const freshAvail = s.fresh.filter(keep).slice(0, s.newLeft);

    // Failed cards that are due again come first.
    const lists = [learning];
    if (reviews.length && freshAvail.length) {
      // Mix new cards in among reviews proportionally.
      const pNew = freshAvail.length / (freshAvail.length + reviews.length);
      lists.push(...(Math.random() < pNew ? [freshAvail, reviews] : [reviews, freshAvail]));
    } else {
      lists.push(reviews, freshAvail);
    }
    lists.push(soon);
    const nonEmpty = lists.filter(l => l.length);
    for (const l of nonEmpty) {
      const c = l.find(x => x.taxonId !== avoid);
      if (c) return c;
    }
    return nonEmpty.length ? nonEmpty[0][0] : null;
  }

  /**
   * Is this card a legitimate thing to show right now? Used to decide whether a card that was
   * prepared in advance can be shown. False if some *other* failed card is waiting, so those
   * still take priority.
   */
  function isAvailable(deckId, taxonId, { skip = new Set() } = {}, now = Date.now()) {
    if (skip.has(taxonId)) return false;
    const s = summary(deckId, now);
    const learning = s.learning.filter(c => !skip.has(c.taxonId));
    if (learning.length && !learning.some(c => c.taxonId === taxonId)) return false;
    if (s.due.some(c => c.taxonId === taxonId)) return true;
    return s.fresh.filter(c => !skip.has(c.taxonId)).slice(0, s.newLeft).some(c => c.taxonId === taxonId);
  }

  /** The most recent review of a card in this deck, or null. */
  function lastReview(deckId, taxonId) {
    let last = null;
    for (const r of Store.reviewsFor(deckId)) {
      if (r.taxonId === taxonId && (!last || r.ts > last.ts)) last = r;
    }
    return last;
  }

  /** For each grade, a label of when the card would be due next. */
  function preview(deckId, taxonId, now = Date.now()) {
    const st = states(deckId).get(taxonId) || null;
    return [1, 2, 3, 4].map(g => FSRS.formatDelay(FSRS.review(st, g, now).due, now));
  }

  return { states, summary, nextCard, isAvailable, lastReview, preview };
})();

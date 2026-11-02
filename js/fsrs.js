// FSRS-4.5 scheduler (pure functions, no storage).
// Reference: https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm
'use strict';

const FSRS = (() => {
  const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031,
    1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
  const DECAY = -0.5;
  const FACTOR = 19 / 81;
  const DAY = 86400000;
  const RELEARN_MS = 10 * 60 * 1000;  // "Again" → see it again in 10 minutes
  const DAY_ROLLOVER_HOURS = 4;        // like Anki: a new "day" starts at 4am
  const MAX_IVL_DAYS = 36500;

  const clampD = d => Math.min(10, Math.max(1, d));
  const retrievability = (elapsedDays, s) => Math.pow(1 + FACTOR * elapsedDays / s, DECAY);
  const initD = g => clampD(W[4] - (g - 3) * W[5]);
  const initS = g => Math.max(0.1, W[g - 1]);
  const nextD = (d, g) => clampD(W[7] * initD(4) + (1 - W[7]) * (d - W[6] * (g - 3)));

  function recallS(d, s, r, g) {
    const hard = g === 2 ? W[15] : 1;
    const easy = g === 4 ? W[16] : 1;
    return s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) *
      (Math.exp(W[10] * (1 - r)) - 1) * hard * easy);
  }
  function forgetS(d, s, r) {
    return Math.min(s, W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)));
  }
  const intervalDays = (s, retention) => s / FACTOR * (Math.pow(retention, 1 / DECAY) - 1);

  /** Timestamp of the start of the scheduling day containing ts. */
  function dayStart(ts) {
    const off = DAY_ROLLOVER_HOURS * 3600000;
    const d = new Date(ts - off);
    d.setHours(0, 0, 0, 0);
    return d.getTime() + off;
  }

  /**
   * Apply one review. state is null for a never-reviewed card.
   * grade: 1=Again 2=Hard 3=Good 4=Easy. Returns a new state object.
   */
  function review(state, grade, now, retention = 0.9) {
    let s, d;
    if (!state) {
      s = initS(grade);
      d = initD(grade);
    } else {
      const elapsed = Math.max(0, (now - state.last) / DAY);
      const r = retrievability(elapsed, state.s);
      d = nextD(state.d, grade);
      s = grade === 1 ? forgetS(state.d, state.s, r) : recallS(state.d, state.s, r, grade);
    }
    s = Math.max(0.01, s);
    let due, ivlDays;
    if (grade === 1) {
      due = now + RELEARN_MS;
      ivlDays = 0;
    } else {
      ivlDays = Math.min(MAX_IVL_DAYS, Math.max(1, Math.round(intervalDays(s, retention))));
      due = dayStart(now) + ivlDays * DAY;
    }
    return {
      s, d, last: now, due, ivlDays,
      reps: (state ? state.reps : 0) + 1,
      lapses: (state ? state.lapses : 0) + (grade === 1 && state ? 1 : 0),
      phase: grade === 1 ? 'learning' : 'review',
    };
  }

  /** Human-friendly label for when a card would next be due. */
  function formatDelay(due, now) {
    const ms = due - now;
    if (ms < 3600000) return Math.max(1, Math.round(ms / 60000)) + 'm';
    const days = Math.round((due - dayStart(now)) / DAY);
    if (days < 1) return Math.round(ms / 3600000) + 'h';
    if (days < 31) return days + 'd';
    if (days < 365) return (days / 30).toFixed(1).replace(/\.0$/, '') + 'mo';
    return (days / 365).toFixed(1).replace(/\.0$/, '') + 'y';
  }

  return { review, retrievability, dayStart, formatDelay, DAY };
})();

// Fuzzy name matching for typed answers.
'use strict';

const Match = (() => {
  const RANK_TOKENS = new Set(['ssp', 'subsp', 'var', 'f', 'forma', 'cv', 'x']);

  function normalize(s) {
    const toks = String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[‘’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ');
    return toks.filter((t, i) => !(i > 0 && RANK_TOKENS.has(t))).join(' ');
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  const tolerance = len => len <= 4 ? 0 : len <= 8 ? 1 : len <= 16 ? 2 : 3;

  /**
   * "G. species" style: if the answer starts with a single letter, compare it against the genus
   * initial (must match exactly) and the rest of the name (typo-tolerant).
   * Returns 0 (exact), a positive distance within tolerance, or -1 (no match).
   */
  function abbrevDistance(a, sciName) {
    const m = a.match(/^([a-z]) (.+)$/);
    if (!m) return -1;
    const toks = normalize(sciName).split(' ');
    if (toks.length < 2 || toks[0][0] !== m[1]) return -1;
    const rest = toks.slice(1).join(' ');
    const d = levenshtein(m[2], rest);
    return d <= tolerance(rest.length) ? d : -1;
  }

  /**
   * Distance from an answer to a group of names: 0 = exact, >0 = within typo tolerance,
   * -1 = no match. `sciNames` also accept the "G. species" abbreviation.
   */
  function distance(a, { names = [], sciNames = [] }) {
    let best = -1;
    for (const n of names) {
      const nn = n && normalize(n);
      if (!nn) continue;
      if (nn === a) return 0;
      const d = levenshtein(a, nn);
      if (d <= tolerance(nn.length) && (best < 0 || d < best)) best = d;
    }
    for (const n of sciNames) {
      if (!n) continue;
      const d = abbrevDistance(a, n);
      if (d === 0) return 0;
      if (d > 0 && (best < 0 || d < best)) best = d;
    }
    return best;
  }

  /** Best-matching group from a list: { group, d } or null. Exact matches win over close ones. */
  function bestOf(a, groups) {
    let best = null;
    for (const g of groups || []) {
      const d = distance(a, g);
      if (d >= 0 && (!best || d < best.d)) best = { group: g, d };
    }
    return best;
  }

  /**
   * Check a typed answer.
   *   card:     { names, sciNames }   the card's own taxon
   *   specific: [{ names, sciNames, label }]  taxa between the card and the observation (inclusive
   *             of the observation's taxon): naming one is correct, just more specific
   *   excluded: [...]  taxa this card never shows because they have their own card in the deck
   *   broader:  [...]  the card's ancestors: naming one is right but too general
   * Returns { result: 'exact'|'close'|'specific'|'excluded'|'broad'|'wrong'|'empty', label? }.
   *
   * Order matters: the card itself wins, then more-specific names. An exact match to an
   * excluded or broader taxon beats a merely close match to a more specific one.
   */
  function check(answer, { card, specific = [], excluded = [], broader = [] }) {
    const a = normalize(answer);
    if (!a) return { result: 'empty' };
    const c = distance(a, card);
    if (c === 0) return { result: 'exact' };
    if (c > 0) return { result: 'close' };
    const sp = bestOf(a, specific), ex = bestOf(a, excluded), br = bestOf(a, broader);
    if (sp && sp.d === 0) return { result: 'specific', label: sp.group.label };
    if (ex && ex.d === 0) return { result: 'excluded', label: ex.group.label };
    if (br && br.d === 0) return { result: 'broad', label: br.group.label };
    if (sp) return { result: 'specific', label: sp.group.label, close: true };
    if (ex) return { result: 'excluded', label: ex.group.label };
    if (br) return { result: 'broad', label: br.group.label };
    return { result: 'wrong' };
  }

  return { check, normalize };
})();

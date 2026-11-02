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
   * Compare an answer against the card's accepted names (and optionally the names of the
   * observation's own, possibly more specific, taxon).
   * Returns { result: 'exact'|'close'|'specific'|'wrong'|'empty', matched }.
   */
  function check(answer, names, obsNames = []) {
    const a = normalize(answer);
    if (!a) return { result: 'empty' };
    let best = null;
    for (const n of names) {
      const nn = normalize(n);
      if (!nn) continue;
      if (nn === a) return { result: 'exact', matched: n };
      const d = levenshtein(a, nn);
      if (d <= tolerance(nn.length) && (!best || d < best.d)) best = { d, n };
    }
    if (best) return { result: 'close', matched: best.n };
    for (const n of obsNames) {
      if (n && normalize(n) === a) return { result: 'specific', matched: n };
    }
    return { result: 'wrong' };
  }

  return { check, normalize };
})();

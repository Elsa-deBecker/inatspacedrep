// Review modes are plugins. Each mode renders the "answer prompt" under the photo and
// calls ctx.reveal({ suggested, feedbackHtml }) when the user has committed to an answer.
// The review screen then shows the answer and the Again/Hard/Good/Easy buttons.
//
// To add a mode later (e.g. multiple choice), call ReviewModes.register('choice', {...}).
// ctx provides: { taxon, photo, deckId, reveal(result), escape(str) }.
// A multiple-choice mode would build its distractors (e.g. via INat taxa/similar_species
// or sibling taxa in the deck) inside mount(), then call ctx.reveal with a suggested grade.
'use strict';

const ReviewModes = (() => {
  const modes = new Map();
  const register = (id, mode) => modes.set(id, Object.assign({ id }, mode));
  const get = id => modes.get(id) || modes.get('self');
  const list = () => [...modes.values()];
  return { register, get, list };
})();

// ---------- Self-graded (Anki style) ----------
ReviewModes.register('self', {
  label: 'Recall, then self-grade',
  mount(el, ctx) {
    el.innerHTML = `<button class="primary big" data-act="show">Show answer <kbd>Space</kbd></button>`;
    el.querySelector('[data-act=show]').onclick = () => ctx.reveal({ suggested: null });
    el.querySelector('button').focus();
  },
  onKey(e, ctx) {
    if (e.key === ' ' || e.key === 'Enter') { ctx.reveal({ suggested: null }); return true; }
    return false;
  },
});

// ---------- Type the name ----------
ReviewModes.register('typed', {
  label: 'Type the name',
  mount(el, ctx) {
    el.innerHTML = `
      <form class="typed" autocomplete="off">
        <input type="text" name="answer" placeholder="Scientific (or G. species) or common name…" spellcheck="false" autocapitalize="off">
        <button class="primary" type="submit">Check</button>
        <button type="button" data-act="idk">Don't know</button>
      </form>`;
    const form = el.querySelector('form');
    const input = form.answer;
    input.focus();
    form.onsubmit = e => {
      e.preventDefault();
      const t = ctx.taxon;
      const obsT = ctx.photo.taxon && ctx.photo.taxon.id !== t.id ? ctx.photo.taxon : null;
      const obsNames = obsT ? [obsT.name, obsT.commonName] : [];
      const r = Match.check(input.value, t.names || [t.name, t.commonName], obsNames,
        t.sciNames || [t.name], obsT ? [obsT.name] : []);
      if (r.result === 'empty') { input.focus(); return; }
      input.disabled = true;
      const you = `You typed: <b>${ctx.escape(input.value)}</b>`;
      const fb = {
        exact: ['ok', `✓ Correct. ${you}`, 3],
        close: ['ok', `✓ Close enough (matched “${ctx.escape(r.matched)}”). ${you}`, 3],
        specific: ['ok', `✓ Correct, and more specific than this card asks. ${you}`, 3],
        wrong: ['bad', `✗ Not quite. ${you}`, 1],
      }[r.result];
      ctx.reveal({ suggested: fb[2], feedbackHtml: `<div class="feedback ${fb[0]}">${fb[1]}</div>` });
    };
    form.querySelector('[data-act=idk]').onclick = () =>
      ctx.reveal({ suggested: 1, feedbackHtml: `<div class="feedback bad">Didn't know.</div>` });
  },
});

# iNat Spaced Repetition

Anki-style spaced repetition for learning to identify taxa, except every review shows a
**different photo**: a random research-grade iNaturalist observation that has exactly one
photo, licensed CC0, CC BY, or CC BY-NC. Because you never see the same photo twice in a row
(until a taxon's supply runs out), you learn the organism instead of memorizing the picture.

## Running it

Double-click `index.html`. It runs entirely in your browser with no install, build step, or
server. Data is saved in the browser's local storage, so use the same browser each time,
and use **Export** on the home screen for backups.

## Features

- **Cards can be any rank**, from kingdom down to subspecies. A genus card shows photos of any member of that genus.
- **Three ways to add taxa:**
  - Search with autocomplete.
  - Paste a list of names. Each one is looked up, and anything that isn't an exact match is flagged for you to check.
  - Generate from iNat: the top *N* most-observed species within a taxon, optionally limited to a place.
- **Two review modes**, set per deck:
  - Recall, then self-grade: Space to reveal, 1–4 to grade.
  - Type the name: scientific or common name, typo-tolerant, with a suggested grade you can override.
  - If a card is a genus and you type the observation's exact species, it counts as correct.
- **Scheduling uses FSRS-4.5** (the algorithm modern Anki uses), with 90% target retention, an Anki-style 4am day boundary, a configurable new-cards-per-day limit, and "Again" bringing the card back in 10 minutes.
- **Photo supply warnings:** if a taxon has fewer than 10 eligible single-photo observations, you get a warning with a one-click option to include multi-photo observations for that card. The first photo with an allowed license is used. **Check photo supply** on the deck page checks every card in advance.
- **"Bad photo, never show again"** hides an observation permanently, e.g. a blurry shot, a specimen label, or the wrong subject.
- **Attribution** is shown on every photo, with links to the observation and taxon after you reveal the answer.

## How it's built (for future extensions)

| File | Role |
|---|---|
| `js/storage.js` | **The only place data is persisted.** Swap this to add cross-device sync. |
| `js/fsrs.js` | FSRS scheduler (pure functions). |
| `js/scheduler.js` | Replays the review log into card states and picks the next card. |
| `js/inat.js` | iNat API client, throttled to about 1 request/sec as iNat requests. |
| `js/photos.js` | Per-taxon photo pools: sampling, caching, and choosing unseen observations. |
| `js/modes.js` | Review-mode plugins (`self`, `typed`). |
| `js/match.js` | Fuzzy name matching. |
| `js/app.js` | UI (hash router: `#/`, `#/deck/:id`, `#/study/:id`). |

**Sync-ready data model.** Reviews are an append-only log with unique IDs, and card schedules
are *derived* from the log, never stored. Decks and cards merge last-write-wins by timestamp.
So merging two devices just means unioning their logs; **Import** already does this. Adding
real sync means replacing `storage.js` with something that does the same merge against a
shared backend (a synced file, Supabase, Firebase, etc.).

**Planned extension points:**
- *Multiple choice:* register a new mode in `modes.js` with `ReviewModes.register('choice', { label, mount(el, ctx) })`
  that builds distractors and calls `ctx.reveal({ suggested })`.
- *More photo filters* (place, month, life stage, annotations…): `INat.observations()` accepts an `extra`
  object of iNat observation-search parameters. Pass per-card or per-deck filters through
  `Photos.next()` and include them in the pool cache key.

## Notes

- Photo pools are cached in local storage for 30 days (up to 250 observations per taxon) and are not exported. They're refetched as needed.
- For very common taxa (more than 10,000 observations), observations are sampled with iNat's random ordering. For rarer taxa, random pages are drawn until the whole set has been seen.

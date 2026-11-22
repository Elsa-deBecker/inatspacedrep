# iNat Spaced Repetition

Anki-style spaced repetition for learning to identify taxa, except every review shows a
**different photo**: a random research-grade iNaturalist observation that has exactly one
photo, licensed CC0, CC BY, or CC BY-NC. Because you never see the same photo twice in a row
(until a taxon's supply runs out), you learn the organism instead of memorizing the picture.

## Running it

Open the hosted copy on GitHub Pages (works on phones too), or double-click `index.html` to run it
from disk. Either way it runs entirely in your browser with no install, build step, or server. It
needs an internet connection: Leaflet loads from cdnjs, and map tiles come from Esri and iNat.
Data is saved in the browser's local storage; use **Export** on the home screen for backups.

## Syncing between devices

The home screen's **Sync between devices** panel stores your data in a private GitHub Gist.
[Create a classic token](https://github.com/settings/tokens/new?scopes=gist&description=iNat%20SRS%20sync)
with only the `gist` scope and paste it in on each device. The first device creates the gist; the
others find it automatically. The app then syncs when you open it, when you return to the tab, and
about 20 seconds after any change. Each sync downloads the gist, merges it in (the same merge as
**Import**), and uploads the result only if anything changed, so no review is ever lost.

Note that the GitHub Pages copy and the double-clicked local copy are different origins with
separate storage. Connect both to sync them, or just use one.

## Features

- **Cards can be any rank**, from kingdom down to subspecies. A genus card shows photos of any member of that genus.
- **Broader cards exclude narrower ones in the same deck.** With cards for *Anatini* and Mallard, the Anatini card
  never shows Mallards, so it trains "a dabbler that isn't a Mallard" (Mallards are ~70% of *Anas* photos on iNat,
  so without this the broad card would mostly be a second Mallard card). The answer side says what's excluded.
- **Photo filters** limit which observations a card's photos come from: place, annotations ("is" or "is not",
  e.g. Life Stage, Sex, Alive or Dead, Evidence of Presence, Flowers and Fruits), a month range (can wrap around
  the new year) and a date range.
  - Set defaults for the whole deck, then add filters per card on top (a card's place, months and dates replace
    the deck's; annotations from both apply). Cards can also ignore the deck's place or other filters.
  - The *Extra photo filters* box above the add tabs applies to cards added by any method. Re-adding a card that
    exists with different filters asks whether to change them.
  - "Is not" keeps unannotated observations, while "is" only keeps annotated ones, so prefer "is not" where it fits.
- **Three ways to add taxa:**
  - Search with autocomplete.
  - Paste a list of names. Names the app already knows (from any deck) match instantly; the rest are looked up at iNat's
    rate limit of about one per second, and each row appears as soon as it's found. Anything that isn't an exact match is flagged for you to check.
  - Generate from iNat: the top *N* most-observed species within a taxon, counted with the current photo filters
    (so a place and months filter gives the commonest species there and then).
- **Two review modes**, set per deck:
  - Recall, then self-grade: Space to reveal, 1–4 to grade.
  - Type the name: scientific (`Genus species` or `G. species`) or common name, typo-tolerant, with a suggested grade you can override.
  - On a broader card, naming the observation's more specific taxon counts as correct (typos allowed, and a
    subspecies observation accepts its species). Naming a taxon the card excludes is wrong, with an explanation.
  - On a narrower card, naming a broader group ("Anas" for a Mallard) is marked wrong as too general.
- **Scheduling uses FSRS-4.5** (the algorithm modern Anki uses), with 90% target retention, an Anki-style 4am day boundary, and a configurable new-cards-per-day limit.
  - "Again" on a card you've never gotten right brings it back in 1 minute; on a card you'd learned, in 5 minutes.
  - After an "Again", the card comes back with **the same photo**. Once you get it right, it goes back to fresh photos.
  - Cards come in **random order** (reshuffled daily), or "as added" (a per-deck setting).
- **Maps:**
  - Question side: where the photo was taken, shown within its state or province (country as fallback). Obscured locations appear as a dashed circle. This can be turned off per deck.
  - Answer side: the taxon's whole distribution (iNat's observation grid), plus iNat's range map when one exists.
- **Fast card changes:** the next card (taxon, photo, map data) is prepared and its image downloaded while you're still looking at the current one.
- **Photo supply warnings:** if a taxon has fewer than 10 eligible single-photo observations, you get a warning with a one-click option to include multi-photo observations for that card. The first photo with an allowed license is used. **Check photo supply** on the deck page checks every card in advance.
- **"Bad photo, never show again"** hides an observation permanently, e.g. a blurry shot, a specimen label, or the wrong subject.
- **Attribution** is shown on every photo, with links to the observation and taxon after you reveal the answer.

## How it's built (for future extensions)

| File | Role |
|---|---|
| `js/storage.js` | **The only place data is persisted.** Also has export and the idempotent merge. |
| `js/sync.js` | GitHub Gist sync: download → `Store.mergeJSON` → upload. Token kept outside the exported data. |
| `js/fsrs.js` | FSRS scheduler (pure functions). |
| `js/scheduler.js` | Replays the review log into card states and picks the next card. |
| `js/inat.js` | iNat API client, throttled to about 1 request/sec as iNat requests. |
| `js/filters.js` | Photo filters: deck + card combination, same-deck exclusions, iNat query params, summaries, annotation vocabulary. |
| `js/photos.js` | Per-card photo pools (keyed by taxon + filters): sampling, caching, choosing unseen observations, image preloading. |
| `js/maps.js` | Leaflet maps: observation location (question) and taxon distribution and range (answer). |
| `js/modes.js` | Review-mode plugins (`self`, `typed`). |
| `js/match.js` | Fuzzy name matching. |
| `js/app.js` | UI (hash router: `#/`, `#/deck/:id`, `#/study/:id`). |

**Sync-ready data model.** Reviews are an append-only log with unique IDs, and card schedules
are *derived* from the log, never stored. Decks and cards merge last-write-wins by timestamp.
So merging two devices just means unioning their logs; **Import** and `sync.js` both do this.
A different backend (Dropbox, Supabase, etc.) would only need its own download/upload in `sync.js`.

**Planned extension points:**
- *Multiple choice:* register a new mode in `modes.js` with `ReviewModes.register('choice', { label, mount(el, ctx) })`
  that builds distractors and calls `ctx.reveal({ suggested })`.
- *More photo filters:* add the field to the filter object in `filters.js` (`clean`, `combine`, `query`, `parts`)
  and a control in `filterEditor()` in `app.js`. The pool cache key picks it up automatically.

## Notes

- Photo pools are cached in local storage for 30 days (up to 250 observations per taxon) and are not exported. They're refetched as needed.
- For very common taxa (more than 10,000 observations), observations are sampled with iNat's random ordering. For rarer taxa, random pages are drawn until the whole set has been seen.

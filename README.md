# Final Fantasy MTG Collection Tracker

A single-page collection tracker for the *Magic: The Gathering* — **Final
Fantasy** sets, covering all 1,365 printings across FIN, FIC, FCA, the art card
and token sets, and the promos.

It shows each card under its **Final Fantasy flavour name** as well as its
original Magic name, and tracks quantities **per finish** — non-foil, traditional
foil, surge foil, wave foil, promo, serialized — offering only the finishes a
given printing actually exists in.

No build step, no framework, no server. Plain HTML, CSS and JavaScript, designed
to be published on GitHub Pages.

**→ Never done this before? Start with [GITHUB-SETUP.md](GITHUB-SETUP.md)** —
a step-by-step walkthrough for getting the site online, written for a
non-technical reader.

**→ Already online? [SETUP.md](SETUP.md)** covers connecting your Google Sheet
so your collection syncs between devices.

---

## Features

- **Binder view** with card images, and a **spreadsheet view** for fast entry
- Per-finish quantity tracking, with only the finishes each printing comes in
- Search across flavour name, Magic name, type line, rules text, flavour text,
  artist and collector number
- Filters for ownership, FF game, set, printing style, frame treatment, rarity
  and colour identity — all generated from the data, so no filter can offer a
  value that matches zero cards
- Live dashboard: unique prints owned, total copies, completion percentage, and a
  rough market value estimate
- Per-game completion pills that double as filters
- Condition, storage location and serial number per card
- CSV export and JSON backup / restore
- **Installable** — add it to your phone's Home Screen and it works offline
- Mobile layout down to 380px: collapsible tools menu, collapsible filters,
  thumbnail list view, and a reduced table that keeps only the columns you need
  for entry
- **Syncs through your own Google Sheet** — the same collection on your laptop
  and your phone, and you can open the sheet and edit it by hand

## Not yet built

- **Non-English copies.** Marking that you own, say, a Japanese printing of a card
  is designed but not implemented.

---

## Files

| File | What it is |
|---|---|
| `index.html` | The page |
| `style.css` | All styling, including the responsive layout |
| `app.js` | All behaviour: state, filtering, rendering, import/export |
| `cards_data.js` | **Generated.** The card database (`const CARDS_DATA = [...]`) |
| `sw.js` | Service worker — offline support and image caching |
| `manifest.webmanifest` | Makes the site installable |
| `GITHUB-SETUP.md` | Beginner walkthrough: getting the site online |
| `SETUP.md` | Connecting your Google Sheet, and the phone setup |
| `google-apps-script/Code.gs` | Goes in **your** Google Sheet — the sync endpoint |
| `generate_ff_tracker.py` | Builds `cards_data.js` and the spreadsheet exports from Scryfall |
| `tools/make_icons.py` | Regenerates the app icons (standard library only) |
| `tools/check_wiring.py` | Static check that the HTML, CSS and JS agree with each other |
| `.github/workflows/` | Monthly card data + price refresh |
| `Old/` | Previous versions, kept for reference |

---

## Running it locally

Open `index.html` in a browser and it works — the card data is a plain script,
not a `fetch`, precisely so that this works off the filesystem.

The service worker won't register from `file://` (browsers don't allow it), so
you won't get offline support locally. To test that part, serve the folder over
HTTP:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

---

## Regenerating the card data

```bash
pip install -r requirements.txt

python generate_ff_tracker.py             # everything: cards_data.js + xlsx + csv + tsv
python generate_ff_tracker.py --only-js   # just cards_data.js (what the website needs)
python generate_ff_tracker.py --dry-run   # write *.new files, touch nothing existing
```

This queries the Scryfall API (about 14 paged requests, rate-limited politely)
and rebuilds the outputs. Records are written in a stable order so that a price
refresh shows up as a handful of changed lines rather than a reshuffled file.

The scheduled workflow runs `--only-js` on the 1st of each month and commits only
if something changed.

### Regenerating the icons

```bash
python tools/make_icons.py
```

Pure standard library — no Pillow, no image tooling.

### Checking your changes

```bash
python tools/check_wiring.py
```

Catches the mistakes a project with no build step and no tests is prone to: an
element id `app.js` reads but `index.html` doesn't define, a `data-action` with no
handler, a CSS class that was never defined, unbalanced braces, and references to
files that don't exist.

---

## How your collection is stored

Ownership lives in the browser's `localStorage` under `ff_mtg_collection_v3`:

```jsonc
{
  "schema": 3,
  "deviceId": "dev_a1b2c3",
  "updatedAt": 1699999999999,
  "cards": {
    "<scryfall-uuid>": {
      "variants": { "nonfoil": 2, "foil": 1 },
      "serialNumbers": {},
      "condition": "Near Mint (NM)",
      "location": "Binder 1, page 4",
      "updatedAt": 1699999999999
    }
  }
}
```

Two deliberate choices:

- **Cards are keyed by their Scryfall UUID**, which is stable across regenerations
  of `cards_data.js`. Refreshing prices never orphans your collection.
- **Only cards you have actually touched are stored.** Reading a card's state
  never creates an entry, so the saved payload is proportional to your collection
  — a few KB, not a few hundred. A card stepped back to zero is deliberately kept
  as a zeroed row, because that row is what tells the other device it was removed.

Older data saved under `ff_mtg_collection_v2_variants` is migrated automatically
the first time you load the new version.

## How syncing works

The browser copy is the working copy: every edit lands there first, instantly,
online or not. Your Google Sheet is the shared copy that lets two devices see the
same collection.

```
  edit a card  ->  saved to this device immediately
                   ...4 seconds of no further edits...
                -> sent to your sheet
                -> sheet merges it and returns anything the other device changed
```

Merging happens inside the Apps Script rather than in the browser, so two devices
saving at the same moment fold into each other instead of one overwriting the
other. Every card carries its own `updatedAt`, so "newest wins" is decided *per
card* — editing a different card on each device loses nothing.

Design points worth knowing:

- **Deletes are tombstones.** Stepping a card back to zero keeps a zeroed row
  rather than removing it. Delete the row and the other device's older non-zero
  copy would look like the only opinion available and resurrect the card.
- **Conflicts are settled by device timestamp, not arrival order.** A phone
  that has been offline for a week cannot overwrite newer work on the laptop just
  because it reconnected afterwards. The cost is that this trusts device clocks;
  a ten-minute grace window absorbs normal drift.
- **Requests are deliberately plain** — GET with query parameters, POST with a
  `text/plain` body. That keeps them "simple" cross-origin requests. Sending
  `application/json` would trigger a preflight check Apps Script cannot answer,
  and every save would fail.
- **Routine saves send only what changed.** A first connection, or pressing
  **Sync now**, reconciles everything.
- **Closing the page flushes** any unsent changes with `sendBeacon`, which
  survives the page going away where a normal request would be cancelled.

Sync settings live under `ff_mtg_sync_v1` in `localStorage` — which sheet address
this device uses, and when it last synced. It never leaves the device.

---

## Credits and licensing

- Card data and images come from **[Scryfall](https://scryfall.com)**. Images are
  hotlinked from Scryfall's CDN rather than rehosted, which is what they ask for.
- *Magic: The Gathering* is © Wizards of the Coast.
- *Final Fantasy* is © Square Enix.

This is an unofficial personal collection tracker, not affiliated with or
endorsed by any of the above. The code is MIT licensed — see [LICENSE](LICENSE).
Card names, images and game text remain the property of their respective owners.

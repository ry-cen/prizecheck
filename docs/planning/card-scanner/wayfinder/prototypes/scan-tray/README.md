# Scan tray prototype

This prototype is for map ticket 3, "Prototype the scan tray" (no GitHub issue yet). It's design evidence only, not production code. It builds on the [card scanner map](../../map.md) and the [scanner plumbing resolution](../../resolutions/decide-scanner-plumbing.md) (D8 finish rule and lock outcomes, D10 pending save, D11 stale rows, D12 caps). The camera is simulated. The measurement gate (G0 to G10) is still open and is not part of this work.

## How to run it

One self-contained page, [`index.html`](index.html): vanilla JavaScript, data in memory, nothing saved, colours and spacing from `web/src/tokens.css`. Serve the worktree root.

Local:

```bash
python3 -m http.server 5194 --bind 127.0.0.1
```

Then open `http://127.0.0.1:5194/docs/planning/card-scanner/wayfinder/prototypes/scan-tray/index.html`.

Tailnet (for the iPhone):

```bash
python3 -m http.server 5194 --bind "$(tailscale ip -4)"
```

(or the Mac's 100.x address from the Tailscale menu), then open `http://<mac-name>.<tailnet>.ts.net:5194/docs/planning/card-scanner/wayfinder/prototypes/scan-tray/index.html` on the iPhone. Plain HTTP is fine because the camera is simulated.

The server exposes the whole worktree to the tailnet while it runs. Stop it with Ctrl-C after the review.

## The purple bar and the simulators

On a phone the bar is a 44 px strip at the top that scrolls sideways. On a desktop it floats at the bottom.

- **Prototype state:** one entry per state, grouped Entry, Start, Camera, Tray, Problems, Save. Each loads by URL too.
- **Camera states only:**
  - **Card:** what to hold up (every fixture except Zeraora, plus Unknown card).
  - **Place:** puts it in the frame and opens a new placement.
  - **Lock:** the auto-lock. It is refused, with a note, when nothing is placed, when the gate isn't OK, or when the card hasn't left the frame since its last lock.
  - **Leaves frame:** takes the card away.
  - **Gate:** OK, Blurry, Dark, Glare.
  - **Offline:** toggles the connection.
  - The shutter in the app ignores the "must leave the frame" rule.
- **Next save** (tray states): what the next Confirm does. Adds the cards, Finishes changed (the server's `EDITIONS_CHANGED`), Location changed (`DESTINATION_CHANGED`), No answer (retry state after 1.5 s), Hold (stays saving). Finishes changed and Location changed apply once, then go back to Adds the cards.
- **Stale view A/B:** shown when the state has stale rows.
- **Phone frame** (desktop only), **Reset** (reloads the current state), **Hide** (the "P" tab at the top brings the bar back).
- Buttons that aren't part of the prototype show a short "Not part of this prototype" note.

## URL params

`screen`, then the defaults first. `setURL()` writes back every non-default value.

| Param | Values | Meaning |
|---|---|---|
| `screen` | `collection` / `import` / `blocked` / `ready` / `scan` / `done` | screen |
| `why` | `denied` / `nocamera` / `noindex` | blocked: demo note only |
| `tray` | `some` / `empty` / `full` | seed, empty, or seed plus fillers to 200 Editions |
| `sheet` | `peek` / `open` | tray detent |
| `gate` | `ok` / `soft` / `dark` / `glare` | camera hint |
| `hint` | `none` / `unresolved` / `offline` | hint shown on load; stays until the next action |
| `net` | `on` / `off` | connection |
| `stale` | `0` / `1` | add the two stale rows |
| `staleview` | `a` / `b` | stale presentation |
| `save` | `none` / `pending` / `retry` / `editions` / `destination` / `old` | save state on load |
| `dialog` | `none` / `dest` / `full` / `clear` | open dialog |
| `search` | `0` / `1` | miss search open |
| `sound` | `0` / `1` | lock sound (needs a tap to start audio on iOS) |
| `lockdemo` | `0` / `1` | place Ralts, auto-lock 400 ms later |
| `hold` | `0` / `1` | freeze the ready bar at 40% |
| `frame` | `phone` / `off` | phone frame (default: phone on a desktop; a phone is always full-bleed) |
| `bar` | `1` / `0` | purple bar shown |

## The flow

1. **Collection:** "Scan cards" in the actions row and in the phone header. The first open in a page load goes through Getting ready; later opens go straight to the camera.
2. **Collection Import:** Camera is a third choice beside Upload a file and Paste, with a Start scanning button. "Put cards in" and "Review import" are hidden for Camera.
3. **Can't start:** one screen whatever the cause. Search for cards, Import from another tracker, Try again, and Review tray when the tray holds cards.
4. **Getting ready:** a progress bar over an empty guide. The tray peek still works.
5. **Camera:** full screen, no app header or tab bar. Close and a sound toggle on top, the guide and hint pill, the shutter, and the tray peek. Locks add rows, or add 1 to the newest row of the same Printing. A lock cue is a guide flash, the peek row rising, a vibration (where available), and an optional sound.
6. **Tray (open):** Put cards in, rows with one-tap finish chips, stepper, Change card, Clear tray, and Add N cards to <path>. The camera pauses behind it.
7. **Misses:** the shutter with no card, an unknown card, or Mew opens search. An auto-lock on Mew shows "Couldn't add this card. Tap the shutter to search."
8. **Confirm:** lands on the destination's Collection with the toast and no Undo.

## Layout

Recommendation (implemented): the scanner is full screen. The tray is a bottom sheet over the full-bleed camera with two detents. Peek is about 136 px: handle, "Tray", the total, a Review button and the last-touched row. Open is 85% of the height and pauses scanning ("Keep scanning" or a tap on the camera strip returns). The peek has no Confirm, so the collector sees the list before adding.

Rejected:

- **Split view** (camera on top, list below): it halves the guide on a phone, and the list is too short to review on.
- **Side drawer:** it covers the guide and doesn't suit one-handed use.
- **A desktop two-column variant:** laptops aren't tuned, and tablets get the same column.

## Stale rows

A row whose Edition is no longer listed keeps its old Edition, shows no chip as selected, and blocks Confirm until the collector picks. A row whose Printing is gone shows no chips and opens Change card with the search.

- **A, in place:** the rows stay where they are, with a warning banner at the top ("N rows need a finish before you can add them." and a Show button that jumps to the next one).
- **B, grouped:** the rows are pulled into a "Needs you N" group at the top. Resolved rows stay in the group, without the pill, until the sheet closes, so nothing jumps under the finger.

Both use the same footer line, "N rows need a finish.". They differ only in placement. Recommendation: A, because the tray's order stays the order the collector scanned in; B is the better choice if stale rows are usually many.

## Mock data

| Printing | Editions, in order | Default |
|---|---|---|
| Iono PAL 185 | Holo | Holo (single Edition, no chips) |
| Snorlax LOR 143 | Holo, Normal, Unspecified Variant | Unspecified Variant |
| Ralts SVI 084 | Normal, Reverse Holo | Normal |
| Charizard ex OBF 125 | Holo, Reverse Holo | Holo (no Normal, so the first) |
| Rare Candy SVI 191 and PAL 189 | Normal, Reverse Holo | Normal (reprint twins, same art colour) |
| Lucario SSP 114 | Normal, Reverse Holo, Reverse Holo, Poké Ball | Normal |
| Basic Lightning Energy SVE 004 | Normal | Normal (no art) |
| Dreepy TWM 128 | Normal, Reverse Holo (inactive), Reverse Holo, Poké Ball, Reverse Holo, Master Ball | Normal (stale: Edition gone) |
| Zeraora SCR 051 | Holo, whole Printing missing | n/a (stale: Printing gone) |
| Mew PR SV053 | Holo (inactive) | none (unresolved lock) |
| Arven OBF 186 | Normal, Reverse Holo, Unspecified Variant | Unspecified Variant (search only) |

`defaultEdition(editions)` implements the owner's rule: no active Edition gives none; one gives it; else an Unspecified Variant; else a Normal; else the first. The seed tray is 21 cards in 7 rows. `stale=1` adds Dreepy ×2 and Zeraora ×1 (24 cards). `tray=full` adds 193 fillers for 200 Editions. Card art is flat colour only.

## Questions for the owner

1. **Layout:** while scanning, the tray sits in a bar at the bottom showing the last card you scanned, and you swipe it up to review everything (the camera pauses). Does that work for you, or would you rather see the camera and the list side by side?
2. **Stale rows:** when a card's finish is no longer listed, should that card be marked where it is in the tray, with a note at the top that jumps to it (A), or pulled into a "Needs you" group at the top (B)?
3. **Guide wording:** the outline said "Line up the card's own edges, not its case." Is "case" the right word for what you'd take off, and is it fine to scan cards still in a penny sleeve?
4. **Entry buttons on the phone:** Collection's phone row now reads Add cards, Scan cards, Import…, Select, and there is also a camera button in the phone header. Is that order right, and do you want both?
5. **First-open line:** "Getting the scanner ready" shows only the bar. Should it add a line like "This takes a little while the first time"? (Only mostly true: iOS can clear the download.)
6. **No Confirm in the bottom bar:** adding cards needs one swipe up to the full tray first, so you always see the list before confirming. Okay, or do you want Add on the bottom bar too?
7. **Removing a row:** at a count of 1, the minus button becomes a bin that removes the row. Is that clear enough, or do you want a separate Remove?
8. **Camera from Collection Import:** Camera is a third choice next to Upload a file and Paste, with a Start scanning button. Is that where you'd look for it?

## Not covered

- The measurement gate G0 to G10 (still open) and the real recognition pipeline.
- The real camera, permission prompts and vibration.
- Screen readers.
- A failed first download.
- Real search.

Notes for the spec: the app's text inputs are 13 px, so iOS zooms on focus; the tray's search field needs 16 px on a phone. The import's finish picker is a menu, but the tray uses one-tap chips, so the spec must say which component it reuses.

## Checks — 2026-10-22

Playwright (Chromium, `/tmp/scan-tray-check/check.cjs`, scratch, not in the repo): 20 checks (three phone sizes, desktop, and 16 flows), all passed, no console errors, page errors, failed responses or external requests.

- **Every state (30) at 430x932, 440x956 and 375x812** (touch, 3x): background `rgb(18, 17, 16)`, no horizontal scroll, no forbidden words in the app's text, every visible button, input, select and radio at least 44x44, the shutter and Confirm inside the viewport and clear of the purple strip.
- **Every state at 1440x900:** framed at 440 wide. Collection, Import, the scanner and Can't start also render with `frame=off`.
- **Flows:** finish defaults for all fixtures, absence rule, repeat lock on the newest row, misses and search, unresolved lock, offline, stale A and B, finishes-changed and location-changed saves, the destination picker's leaves, the full tray, pending, retry and 29-day states, Confirm landing, Clear tray, Getting ready, entry points, the bar and frames, and no forbidden APIs.
- **Not verified:** iOS Safari (`100dvh` with the toolbar, safe areas, the 16 px zoom rule, audio unlocking), real touch swipes, and screen readers. The owner's iPhone review is the real check.

## Owner verdict

2026-10-22, all eight questions answered on the owner's iPhone:

1. **Layout:** the bottom sheet, accepted. The guide was widened to 86% of the frame width (height capped at 80%) to match the spike's geometry.
2. **Stale rows:** A, in place. B is rejected.
3. **Guide wording:** no standing note. The hint pill shows only for camera hints (soft, dark, glare), lock outcomes and offline, and is hidden otherwise.
4. **Entry buttons:** accepted as is, with both the actions row and the header button.
5. **First-open line:** none. Getting ready shows only the heading and the bar.
6. **No Confirm in the bottom bar:** accepted.
7. **Removing a row:** the bin at a count of 1, accepted.
8. **Camera from Collection Import:** accepted.

# Card scanner — decision map

**Label:** wayfinder:map

**Status:** charting since 2026-10-21. No tickets opened yet.

## Destination

A handoff-ready spec at `docs/planning/card-scanner/spec.md` for adding cards to a Collection with a phone camera: the collector scans a stack of English cards, reviews the matches in a tray, and saves them into one Storage Leaf. The spec must settle the domain terms, the on-device recognition pipeline, the tray, the save contract and the tests. A recognition spike must first show that on-device recognition meets the accuracy bar.

## Notes

- Owner request on 2026-10-21: a card scanner through the camera, chosen ahead of Trading Stage 2. Stage 1 trading had just merged to `dev`, Stage 2 still needs its safety decisions, and faster entry fills trade binders.
- The scanner is Collection Import with a camera as its source. Collection Import's review is "the safety net"; the scanner keeps the same promise: it only adds Holdings, all into one chosen Storage Leaf, and nothing is saved until the collector confirms.
- A scan only suggests a Card Edition, and the collector confirms it. This follows the physical-Edition identity in [ADR 0007](../../../adr/0007-edition-marketplace-metadata-boundary.md): neither OCR of a set number nor an image match can decide a finish.
- Reference artwork and its gaps (missing energies and trainer kits in TCGdex) are covered in [card image sources](../../tcg-collection-tracker/wayfinder/research/card-image-sources.md). Cards without reference artwork can only be recognized by their collector number.
- What comparable apps do (read 2026-10-21, mostly vendor and review-blog claims): dedicated scanner apps advertise on-device recognition that works offline; several combine image recognition with OCR; confirming set, number and finish after the scan is common; reprints that share artwork, vintage cards and Japanese cards are the usual weak spots. Nearly all are native apps, so a browser scanner is less proven.
- New terms (working names: scan tray, scan session) are defined through domain-modeling as they are resolved. `CONTEXT.md` is not changed by this map.
- The owner delegates technical plumbing (recognition pipeline, models, index format, caching, API contracts): decide and record it, and grill the owner only on collector-facing effects, one question per message.
- Follow AGENTS.md's UI copy rule: the scanner shows no recognition scores, model or source names, or index versions. Consult Laya before delegation. Ask before creating a `feature: card scanner` label or any GitHub issue. Commit and push only with owner approval; stage explicit paths.

## Decisions so far

<!-- One line per closed ticket: link plus a one-line gist. -->

- Review tray (owner, 2026-10-21, before tickets): each scan goes to a tray. Nothing reaches the Collection until the collector confirms the tray.
- On-device only (owner, 2026-10-21, before tickets): recognition runs on the collector's device. No card photo is uploaded or stored, ever, not even a thumbnail. "Accurate enough" is acceptable because the tray catches mistakes.
- Accuracy bar (owner, 2026-10-21, before tickets): across a mixed stack of the owner's real cards, the right card is among the tray's top 3 candidates at least 9 times in 10 and is the first candidate at least 7 times in 10. Measured on phones and tablets.
- English only (owner, 2026-10-21, before tickets): the catalog is English-only, so the scanner recognizes English cards and the tray has no language choice.
- Capture (owner, 2026-10-21, before tickets): automatic. A card locks in when consecutive frames agree, with a vibration or sound, and a shutter button is the fallback. The same card staying in frame is captured once; taking it out and putting it back counts as a second copy. Each tray row has a count the collector can adjust.
- Finish (owner, 2026-10-21, before tickets): if the matched Card Printing has one active Card Edition, the tray picks it. Otherwise the row defaults to the Unspecified Variant, with one-tap chips for the other Editions. Confirming never requires a finish, and the scanner never guesses one from the image.
- Destination (owner, 2026-10-21, before tickets): one Storage Leaf per scan session, chosen in the tray and defaulting to Unsorted. The scanner only adds Holdings and never changes or removes existing ones.
- Unfinished tray (owner, 2026-10-21, before tickets): the tray is kept on that device until the collector confirms or clears it, surviving reloads and closing the app. It holds Editions and counts only. One tray at a time; it does not sync between devices.
- Entry points (owner, 2026-10-21, before tickets): Scan cards beside Collection's other add actions, a Camera source in Collection Import, and a scan shortcut in the phone header, all opening the same scanner. Built for phones and tablets; laptop webcams work but are not tuned for or counted in the accuracy bar. Without a camera, or with permission denied, the scanner explains how to allow the camera and offers search and Collection Import instead.
- No prices (owner, 2026-10-21, before tickets): the tray shows no per-card prices and no total. Values stay in Collection.
- Misses (owner, 2026-10-21, before tickets): every tray row offers catalog search beside its top 3 candidates. A shutter press on a card the scanner cannot recognize opens search at once, and the collector picks an Edition (the Unspecified Variant counts) before the card enters the tray. Every tray row always has an Edition; there are no unmatched placeholder rows.

## Plumbing defaults (delegated, recorded 2026-10-21, to be confirmed by the spike and a plumbing resolution)

- **Pipeline.** Find the card's four corners and straighten it; read the collector-number strip with OCR; embed the straightened card and look up the nearest reference fingerprints; combine the two (the number narrows the candidates and the image orders them, or the image alone when OCR fails); vote across several frames before locking.
- **Where it runs.** All of it in the browser, loaded only when the scanner opens. The reference fingerprints are computed on the server from reference artwork, published as a static, versioned, content-hashed index and cached on the device. The spike measures whether image matching earns its download; if OCR alone meets the bar, the first version may ship without it.
- **Shared save, separate draft.** Collection Import's draft is server-side, one per collector, and starting another replaces it. The scan tray is on-device, so it must not create or replace an import draft. The scanner reuses the import's save transaction (one Holding increment per resolved Card Edition into the landing Storage Leaf, one owner-revision advance, an idempotency key for replays) through its own route, and reuses the review's row, candidate, finish-chip and search components in the web app. The Camera source in Collection Import opens the scanner rather than starting a draft.

## Candidate tickets

1. **Recognition spike** (prototype, in a separate throwaway repository): [brief](prototypes/recognition-spike/brief.md). Compare OCR alone, image matching alone and both combined against the accuracy bar, and report download size and speed on real phones. Blocks everything else.
2. **Decide scanner plumbing** (resolution): pipeline and libraries from the spike, the fingerprint index build and publishing, device caching and the save route and its refusals.
3. **Prototype the scan tray** (prototype): the camera view, lock feedback, the tray rows with candidates, count, finish chips and search, and the destination picker, on a phone.
4. **Define scanner terms** (domain-modeling): scan session, scan tray, and how they relate to Collection Import in `CONTEXT.md`.
5. **Write the spec** from the decisions above.

## Not yet specified

- After Confirm: whether there is any undo. Collection Import has none, because the review is the safety net; the default is the same for the scanner.
- Lock feedback: whether the sound can be turned off separately from vibration, and the default.
- Tray size: a cap on rows or copies per tray (Collection Import caps 10,000 source rows; the other add paths batch at 200 items).
- What happens to a saved-on-device tray when the collector signs out or another account signs in on the same device.
- Whether a Deck can be the destination Storage Leaf, and whether scanning into a Deck says anything about its Deck List.
- Staleness: the on-device tray never expires, unlike an import draft's 24 hours, so an Edition or the destination can change while a tray waits. The save route needs a refusal like `REVIEW_CHANGED` that sends those rows back for a new pick.
- Fingerprint rights: [card image sources](../../tcg-collection-tracker/wayfinder/research/card-image-sources.md) covers re-hosting artwork, not deriving and publishing an embedding index from it. Whether that is acceptable needs its own check before the index ships.

## Out of scope

- Uploading or storing card photos, server-side recognition, and syncing the tray across devices.
- Non-English cards; they follow the catalog.
- Prices or values while scanning.
- Recognizing a finish, condition, grade or stamp from the image.
- Sealed product, graded slabs and other games.
- A native app wrapper; the scanner is part of the web app.

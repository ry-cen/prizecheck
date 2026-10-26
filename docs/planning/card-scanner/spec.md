# Spec — Card Scan: adding cards with the phone camera

**Status:** drafted 2026-10-25; the owner answered every open question the same day. It restates decisions the owner has made or plumbing the owner delegated.

**Decision map:** [Card scanner — decision map](wayfinder/map.md). Tickets 1 to 4 are closed. This spec is ticket 5; the ADR is ticket 6. Each section below names the decision it comes from:

- [Recognition spike findings](wayfinder/research/recognition-spike-findings.md)
- [Decide scanner plumbing](wayfinder/resolutions/decide-scanner-plumbing.md) (the **resolution**; D1 to D14, the contracts, the test strategy and the ship blockers)
- [Scan tray prototype and owner verdict](wayfinder/prototypes/scan-tray/README.md)
- [Phone measurement gate results](wayfinder/research/phone-gate-results.md)
- [ADR 0007: Edition and marketplace metadata boundary](../../adr/0007-edition-marketplace-metadata-boundary.md)
- The terms **Card Scan**, **Scan Tray** and **Scan Suggestion** in [`CONTEXT.md`](../../../CONTEXT.md)

Sibling spec: [Collection import](../collection-import/spec.md). The scanner takes its review shape and save promise from it.

## Superseded text

Where the sources disagree, the newest dated owner decision wins. These items in older text no longer hold:

| Older text | Now |
|---|---|
| Resolution D1: `numThreads = 1`, not cross-origin isolated; multi-thread kept as fallback F3 only. | WASM with up to 4 threads, the scanner served as a cross-origin-isolated page that is its own HTML entry (F3's document shape). Owner, 2026-10-23, after the phone gate. The resolution's G1 (threaded wasm running single-threaded without isolation) is now only the fallback path when isolation is missing. |
| Fallback F3: `numThreads = min(4, hardwareConcurrency / 2)`. | The worker sets `self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency ?? 1) : 1`. The phone gate ran 4 threads on a 4-core phone; `/ 2` would have given 2. Primary decision, 2026-10-25. |
| The phone gate's isolation. | The spike sent COOP and COEP on every response (`web/vite.coi.config.ts`), so the gate never met the question of worker and glue scripts needing COEP themselves. The app sends COEP on `/assets/` and the nested `.mjs` location (see Header scope). |
| Resolution D13: `ScannerPage` is a lazy page in Collection's `sections`, with the shell importing `SCANNER_PATH`. | The scanner is its own Vite HTML entry, mounted only there. The shell keeps no in-app route that renders it and only builds the link. See [Web and delivery](#web-and-delivery). |
| Resolution ship blocker 2: "the rest of the gate passes or ends in a recorded fallback". | The owner shipped first although G2, G3 and G4 missed (2026-10-23, 2026-10-24). The unmeasured and missed items are follow-ups, not blockers. See [Deferred recognition work](#deferred-recognition-work). |
| Resolution "Frame voting": a lock needs 3 of 4 agreeing frames of any kind. | Only frames with found card corners or at least one OCR number candidate count toward an automatic lock; an automatic lock also needs the printed number to back the pick. Image-only agreement becomes a Scan Suggestion. |
| Map and resolution "scan session". | The term is dropped. Use **Card Scan** for the act and **Scan Tray** for the unconfirmed list. |
| Spike findings: the guide's copy asks the collector to line up the card, not its case. | The owner chose no standing note on the outline (prototype P3). Only camera hints, lock outcomes and offline show. |
| Resolution `lock` message: `via: "auto" \| "shutter"` and `lockOutcome.reason` of `unresolved \| offline \| full`. | The spike's port adds `via: "suggest"` and the outcome reason `dismissed`. The contract below carries both, plus an `absent` message (see Recognition module). |

## Problem Statement

A collector with a stack of cards to add has two ways in today: searching for each card and adding it one at a time, or moving a list over from another tracker. A binder fills slowly this way. The camera is already in the collector's hand, and cards carry their own name, number and artwork. Faster entry also keeps trade binders current, which Trading depends on.

Three things make a naive scanner a bad fit:

- It can be wrong. Reprints share artwork, some cards have no reference artwork, and a photo does not show a finish. A scanner that adds cards straight to the Collection would corrupt it.
- The collector's photos are private. The owner's decision is that no card photo is uploaded or stored.
- A scanner that locks onto an empty table, or onto a card it only half recognises, wastes the collector's time and trust.

## Solution

A **Card Scan** lets a collector add cards by holding them up to the phone's camera, one at a time. Nothing reaches the Collection until the collector confirms:

- **Where it starts:** **Scan cards** beside Collection's other add actions, a camera button in the phone header, and a **Camera** choice in Collection Import. All three open the same scanner.
- **Recognising a card:** it runs on the phone. The scanner reads the card's printed number and compares its artwork with the catalog. No photo leaves the device or is kept.
- **Locking:** when several frames agree on a Card Printing and the printed number backs the pick, the card locks into the **Scan Tray** with a cue.
- **Suggesting:** when frames agree on a Card Printing only by its artwork, the scanner does not lock it. It shows a **Scan Suggestion** with up to three candidates (normally three). The collector picks one, or chooses **None of these** to search. If the collector takes the card out without answering, the suggestion closes and the card is skipped: nothing is added, and the scanner moves on (owner, 2026-10-25). The suggestion is a card above the tray peek showing each candidate's artwork, set and collector number, so reprints can be told apart (primary's default, offered to the owner on 2026-10-25). A suggestion gets no lock cue: no guide flash, vibration or sound when it appears, and a pick adds its row with the usual row-added motion but no vibration or sound (owner, 2026-10-25).
- **The Scan Tray:** a bottom sheet over the full-screen camera. Each row is a Card Edition with a count, one-tap finish chips, **Change card** and catalog search. The tray is kept on the device, per account, until it is confirmed or cleared.
- **Confirming:** **Add N cards to <Location>** adds every row in one step to one Storage Leaf (not a Deck), Unsorted by default, and lands on that Location.

A Card Scan only adds Holdings. It never changes or removes what is already there, and there is no undo, because the tray is the safety net. A Scan Tray is not a Collection Import draft: starting a Card Scan never creates or replaces one.

The scanner ships into the app now, ahead of the speed and accuracy work the phone gate showed is still open. Recognition sits behind a narrow module interface so a faster replacement can drop in without changing the tray or the save path.

## User Stories

### Starting a Card Scan

1. As a collector, I want **Scan cards** beside Collection's other add actions, so that I can add cards by camera at any time.
2. As a collector on a phone, I want a camera button in the header, so that the scanner is one tap away.
3. As a collector, I want a **Camera** choice beside **Upload a file** and **Paste** in Collection Import, with a **Start scanning** button, so that I find the scanner where I look for ways to bring cards in.
4. As a collector who chose Camera in Collection Import, I want no destination picker or review step on that screen, so that I am not shown steps the scanner does not use. (The scanner has its own destination picker in the tray.)
5. As a collector opening the scanner for the first time, I want it to start getting ready at once, showing **Getting the scanner ready** and a progress bar, so that I do not have to ask for it.
6. As a collector opening the scanner a second time, I want a short loading view with no progress bar before the camera, so that I am not made to wait again. (The same "Getting the scanner ready" heading without the bar.)
7. As a collector whose phone has no camera, whose camera permission is denied, whose browser lacks a needed capability, or for whom the scanner cannot get ready for any other reason (no card index built, a failed or interrupted download, a storage problem), I want one screen that offers **Search for cards**, **Import from another tracker**, **Try again** and, if the tray holds cards, **Review tray**, so that I always have a way forward. The screen names a cause only when I can act on it (no camera, camera denied, unsupported browser, with how to allow the camera); for every other cause it is one generic screen that never mentions the index, downloads or assets.
8. As a collector, I want the scanner full screen with no app header or tab bar, so that the camera and the guide have the room.

### Scanning

9. As a collector, I want a card-shaped guide on the camera, so that I know where to line up the card.
10. As a collector, I want the guide to be large (86% of the frame width, no taller than 80% of its height), so that a high-resolution image of the card fills it.
11. As a collector, I want the scanner to show no standing instruction on the guide, and a short hint only when something is wrong (dark, too bright, glare, offline, a lock that could not be added; "blurry" joins them after the sharpness retune), so that the camera stays clear.
12. As a collector, I want a card to lock by itself when several frames agree and the printed number backs the pick, so that I do not have to press anything.
13. As a collector, I want a lock cue: the guide flashes and the tray row appears, with a short vibration where my phone supports it, so that I know the card was taken.
14. As a collector, I want a short lock sound that is off by default behind one setting, so that a quiet room stays quiet. On an iPhone the lock is silent and still unless the sound is on.
15. As a collector, I want the same card staying in the frame to lock once, and taking it away and putting it back to count as a second copy, so that counts follow what I do with my hands.
16. As a collector, I want a second lock of the same Card Printing to add one copy to its newest tray row, so that I can move it with the counts and chips if it was another finish.
17. As a collector, I want a shutter button as a fallback, so that I can take a card the scanner will not lock by itself.
18. As a collector who presses the shutter on a card the scanner cannot recognise, I want catalog search to open at once, so that I can still add the card.
19. As a collector, I want the shutter to work even when the card has not left the frame, so that I can deliberately add a second copy.
20. As a collector, I want the scanner to ignore an empty table or background, so that nothing is added when no card is there.
21. As a collector, I want the scanner to keep recognising while I am offline, so that a bad connection does not stop a scan. (Adding a row still needs a connection; see Misses and offline.)

### Scan Suggestions

22. As a collector whose card the scanner matched only by its artwork, I want a Scan Suggestion with up to three candidates (normally three) instead of an automatic lock, so that a wrong guess is not added without my say.
23. As a collector, I want to pick one of up to three candidates, so that the card enters the tray as that Card Printing with its starting Card Edition.
24. As a collector, I want **None of these** to open catalog search, so that I can find the right card.
25. As a collector who turned a suggestion down, I want the same card not to be suggested again until I take it out of the guide and put it back, so that I am not asked twice about one placement.
26. As a collector, I want a card whose printed number agrees to enter the tray without a question, so that clear cards stay fast.

### The Scan Tray

27. As a collector, I want the tray as a bottom sheet over the camera, showing its total, a **Review** button and the last card I touched, so that I see progress while scanning.
28. As a collector, I want to swipe the sheet up (or press **Review**) to a full tray that pauses scanning, and return with **Keep scanning** or a tap on the camera strip, so that I can review without the camera locking more cards.
29. As a collector, I want each tray row to show the card, its set and number, a count and one-tap chips for the card's other finishes, so that I can fix a row without leaving the tray.
30. As a collector, I want a row to start on a finish I did not choose only by a plain rule, shown selected and one tap to change, so that confirming never waits on a finish and the finish is never guessed from the photo.
31. As a collector, I want to raise or lower a row's count, with the minus becoming a bin at a count of 1 that removes the row, so that I can correct counts and drop mistakes.
32. As a collector, I want **Change card** and catalog search on every row, so that I can replace a wrong match with the right card and finish.
33. As a collector, I want to choose a Storage Leaf for the cards, Unsorted by default, and to be unable to choose a Deck, so that I know where the cards land.
34. As a collector, I want **Clear tray**, with a confirmation, so that I can start over.
35. As a collector, I want the tray to show no prices and no total value, so that scanning stays about cards.
36. As a collector, I want the tray to survive a reload, closing the app, and restarting my phone, so that an interrupted scan is not lost.
37. As a collector sharing a device, I want my tray hidden from other accounts and back when I sign in again, so that nobody else adds or sees my cards.
38. As a collector, I want one tray at a time on a device that does not sync, so that two devices stay separate.
39. As a collector, I want a full tray (200 distinct Card Editions, 400 rows or 999 copies in a row) to ask me to confirm before scanning more, so that the tray stays a size I can review.

### Stale rows

40. As a collector whose card's finish was removed from the catalog while the tray waited, I want that row to stay where it is, with no chip selected, so that I can pick a finish in place.
41. As a collector, I want a banner at the top of the tray ("N rows need a finish before you can add them.") with **Show**, which jumps to the next such row, so that I can find them in a long tray.
42. As a collector, I want a row whose Card Printing is gone to show no chips and to open **Change card** with search, so that I can replace it.
43. As a collector, I want confirming disabled, with "N rows need a finish.", until every such row is fixed, so that nothing out of date is added.

### Confirming

44. As a collector, I want **Add N cards to <Location>** only in the full tray, so that I always see the list before I add it.
45. As a collector, I want everything added in one step, so that a failure never leaves half a tray.
46. As a collector, I want to land on the chosen Location with a toast saying how many cards were added and no Undo, so that I see the result at once.
47. As a collector who confirms twice or retries after a network error, I want the cards added only once, so that I do not need an undo.
48. As a collector whose destination was moved, converted, deleted or made a Deck while I scanned, I want the confirm refused and the destination picker reopened with my rows kept, so that cards do not land somewhere unexpected.
49. As a collector whose tray holds a finish that was withdrawn from the catalog, I want exactly those rows marked as needing a finish, so that I fix them and confirm again.
50. As a collector whose confirm got no answer, I want the tray frozen with a **Retry** action, so that a retry cannot change what was sent.
51. As a collector whose unanswered confirm is older than 29 days, I want the tray unfrozen with "This tray may already be in your Collection. Check before confirming again.", so that I check before adding twice.
52. As a collector, I want the added cards to be ordinary Holdings I can move, remove or sort like any other, so that a scan leaves no special state.
53. As a collector, I want prices for the new cards to load as I browse like any other card, so that scanning triggers no price checks.

### Misses and offline

54. As a collector, I want a lock that cannot be added, because none of its candidates has an active Card Edition, to say "Couldn't add this card. Tap the shutter to search.", so that I know what to do.
55. As a collector who is offline when a card locks, I want the hint "Can't reach PrizeCheck. Check your connection and scan again.", so that I know why no row appeared.
56. As a collector who opens the tray offline, I want rows to show from what the device already holds, with finish chips and the confirm disabled and a line asking me to reconnect, so that I can still see my cards.
57. As a collector, I want the tray to retry when my connection returns, so that I do not have to reload.

### Phone, accessibility and copy

58. As a collector on a phone, I want no horizontal scroll in the scanner or tray and every control at least 44 px, so that I can use it one-handed.
59. As a collector, I want the tray's search field at 16 px on a phone, so that iOS does not zoom the page on focus.
60. As a collector using a screen reader, I want the lock outcomes, hints, Scan Suggestion, row statuses, chips and the disabled confirm to have names and states that are announced, so that the scanner is usable without sight.
61. As a keyboard user, I want focus to move into the tray, a Scan Suggestion, search and dialogs when they open and back when they close, so that fixing rows works without a mouse.
62. As a collector, I want the scanner never to show recognition scores, model or source names, index versions, fetch times or download state beyond plain progress, so that the screen shows only what helps me decide (AGENTS.md).

### Operations and safety

63. As the owner, I want recognition to run only on the device, with no card photo uploaded, stored or kept, not even a thumbnail, so that collectors' photos stay private.
64. As the owner, I want the scanner used only on the private, sign-in-only deployment until a written rights check covers the derived artwork index, so that a public launch does not outrun the rights.
65. As the owner, I want the card index and number table served only to signed-in collectors, so that derived data is not on public URLs.
66. As the owner, I want a scan to start no catalog pull and no price refresh, so that pulls stay owner-only and prices keep their own path (ADR 0006, ADR 0013).
67. As the owner, I want the recognition code behind one narrow interface, so that a faster port, a retuned gate, WebGPU or a native plugin can replace it later without touching the tray or the save path.

## Implementation Decisions

### Terms

- **Card Scan, Scan Tray and Scan Suggestion** are in `CONTEXT.md`. Use them exactly. Never write "scan session". A Card Scan is a sibling of Collection Import, not a kind of it.
- **Lock** is the implementation word for an automatic or shutter `lock` message that writes a tray row. A Scan Suggestion also travels as a `lock` message (`via: "suggest"`) but writes a row only when the collector picks a candidate, so it is not a lock in the collector's sense.
- The fingerprint index, number table, gate and voting are implementation terms and are not in the glossary.
- Card Printing, Card Edition, Unspecified Variant, Holding, Storage Leaf, Unsorted and Deck mean what `CONTEXT.md` says.

### The finish rule ([D8](wayfinder/resolutions/decide-scanner-plumbing.md#d8-candidates-resolve-to-editions-live-through-one-batch-route))

A scan only suggests a Card Edition and never reads a finish from the photo (ADR 0007). Every row has an Edition. The server computes the starting Edition of a Printing from its active Editions, in this order:

1. no active Edition: none, and the Printing cannot be added;
2. one active Edition: that one;
3. an active Unspecified Variant: that one;
4. an active Normal;
5. otherwise the first active Edition in descriptor order.

The chosen chip shows selected and is one tap to change. Confirming never waits on a finish. This amends the closed Finish decision for Printings without an Unspecified Variant (owner, 2026-10-22).

### Recognition module

- **Boundary.** The main thread grabs camera frames, draws, and owns the tray. All recognition runs in a module Web Worker behind the message contract in the [resolution](wayfinder/resolutions/decide-scanner-plumbing.md#worker-message-contract): the gate, corner finding, warp, OCR, embedding, search, combining and voting. No frame or image data ever travels from the worker back to the main thread. A replacement recognizer must speak this contract and nothing else; the tray and the save path know nothing about how a Printing was recognised.
- **Contract amendments** carried by this spec. The first two are taken from the spike port; the third is new here.
  - `lock.via` gains `"suggest"`. A `suggest` lock carries up to three Printing ids, best first, for the Scan Suggestion. The worker makes no new lock until it receives the matching `lockOutcome`.
  - `lockOutcome.reason` gains `"dismissed"`: `{added: false, reason: "dismissed"}` follows **None of these** or a closed suggestion. It behaves like `added: true` for capture: the card must leave the guide before the next lock or suggestion. It does not pause for 2 s (unlike `unresolved` and `offline`).
  - New `FromWorker` message `{t: "absent"; lockId}`. While a `suggest` lock is pending, the worker keeps tracking absence (the same thumbnail rule as after a lock) and posts `absent` for that `lockId` once, when the card has left the guide. After a `dismissed` outcome the voter is in the locked state and needs a fresh absence before it re-arms (as in the spike's `vote.ts`). On `absent` the main thread closes the suggestion and sends `lockOutcome` `dismissed` (owner, 2026-10-25: a card taken out unanswered is skipped); without it, a pending lock would block all further recognition. The main thread always ends a suggestion with a `lockOutcome`.
  - A picked suggestion is answered like a lock: `lockOutcome {added: true}` or `{added: false, reason: "full"}` (see Misses and offline).
- **Harness-only fields.** The spike's `ready.info` and `error.detail` exist for the measurement harness and are not part of the shipped contract, with `diag`, `resources`, `HarnessInit` and `force`.
- **Where the code comes from.** The app port starts from the spike repository `~/dev/prizecheck-scan-spike`, commit `4e3d827` (unpublished, no remote): `web/src/scanner/vision/`, `web/src/scanner/recognize/` (including `vote.ts` with the eligibility and suggestion rule), `web/src/scanner/worker/recognizer.worker.ts` and `messages.ts`, and the Python exporter `web_export.py`. The [pipeline parity table](wayfinder/resolutions/decide-scanner-plumbing.md#pipeline-parity-table) lists each step's contract and its spike source. The spec does not copy code.
- **Not ported.** The spike's gate harness, its `harness:` message extensions (`diag`, `resources`, `HarnessInit`, `force`, `ready.info`, `error.detail`) and its report tooling are measurement tools and are not shipped. A dev-only timing message may stay behind a flag.
- **Runtime.** `onnxruntime-web` 1.30.0, its `wasm` entry only, imported in `worker/ort.ts` and nowhere else (guardrail: only `worker/ort.ts` imports the runtime), from same-origin hashed `/assets/` URLs. The worker sets the thread count itself, with no message field: `self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency ?? 1) : 1`. This supersedes D1's single thread and F3's `hardwareConcurrency / 2`; the other D1 choices (module worker, `proxy = false`, `worker.format = "es"`, the capability check) stand.
- **Models.** int8 DINOv2-small embedder, Paddle OCR recognizer and its dictionary, pinned by sha256 in `web/scanner-models.lock.json` and fetched at image build ([D3](wayfinder/resolutions/decide-scanner-plumbing.md#d3-models-are-static-assets-in-the-web-image-pinned-by-sha256-fetched-at-image-build)). The first download is about 40 MB.
- **Hand-written image work.** No OpenCV.js ([D2](wayfinder/resolutions/decide-scanner-plumbing.md#d2-image-work-is-hand-written-typescript-not-opencvjs)). Parity with the spike's Python is pinned by fixtures.

### Frame voting and capture

Starting values are the [resolution's rule](wayfinder/resolutions/decide-scanner-plumbing.md#frame-voting-and-capture-starting-rule-ticket-3-tunes-it), unchanged except for the three rules below.

- **Recognition decided by the primary (2026-10-25).** The first release ships the sharpness check off: its threshold came from synthetic images and rejected 85 to 96 percent of real frames. The dark, bright and clipped checks stay, and the eligibility rule and the Scan Suggestion carry the protection. The "Hold steady" hint therefore does not show until the retune lands. Threads are set by the worker as in Runtime above; whether slower phones should use fewer is for the speed pass.
  - Sharpness off is a gate constant (for example `sharpMin: 0`), not a message field. The spike's `bypass` skipped the whole gate, so keeping the dark, bright and clipped checks while skipping only sharpness is new code, not a port.
  - G0 passed (see Ship blockers).
- **Eligibility (owner-checked on the phone, 2026-10-23).** Only an eligible frame (found card corners, or at least one OCR number candidate) counts toward an automatic lock or a suggestion. A frame on the guide-rectangle fallback with no OCR candidate does not count. This stopped every phantom lock on the empty table in the phone check (47 frames without a card, none counted, no lock between cards). Keep the gate's darkness check when the sharpness threshold is retuned; it backs the eligibility rule up.
- **Number-backed or suggestion.** When 3 of the last 4 eligible frames agree on a Printing:
  - if any agreeing frame has that Printing itself among its OCR number candidates, it is an automatic lock (an OCR candidate for a different Printing does not back the pick);
  - otherwise it is image-only and becomes a Scan Suggestion.
  - Evidence: across two phone Lock runs (31 locks), number-backed locks were right 22 of 22 and image-only 3 of 9. No score or lead over the second Printing separated right from wrong, so the rule is on the number, not on a score.
- **One placement, one prompt.** After a lock, a suggestion picked, or a suggestion dismissed, no new lock or suggestion comes until the card has left the guide: at least 2 consecutive analysed frames whose 32x32 grey guide thumbnail differs from the lock frame's thumbnail by a mean absolute difference over 24/255.
- **Shutter.** Unchanged: it locks the leader of the current window (or the current frame's top candidate) as a row, ignores the absence rule, and posts `miss` with no candidate. On an image-only match it still adds the top candidate as a row, because the collector chose to take it. While a Scan Suggestion shows, the shutter is shown disabled (greyed out, announced as unavailable): the suggestion is the choice (owner, 2026-10-25).
- **Gate hints.** The worker's `gate.reason` values map to hints: `dark` to the dark hint, `bright` to the bright hint, `clipped` to the glare hint, and `soft` to the blurry hint, which cannot appear until sharpness is turned back on.

### Misses and offline ([D8](wayfinder/resolutions/decide-scanner-plumbing.md#d8-candidates-resolve-to-editions-live-through-one-batch-route))

- A lock's candidates, up to three Printing ids, are resolved live through `POST /api/scanner/printings`, with a 5 s timeout. The row takes the first candidate that is in the answer with an active Edition. No row is ever written without an Edition.
- A Scan Suggestion calls the same route for its up to three candidates and shows the ones that resolve (one or two if the others have no active Edition, which are left out silently). If none resolves, the outcome is the same as for a lock.
- **A pick behaves as a lock of the chosen Printing:** its starting Edition by the finish rule; the repeat-lock rule (one copy to the newest row of that Printing, else a new row); the picked Printing first in the row's candidates, then the other resolvable candidates; the capacity check (`trayEditAllowed`); then `lockOutcome {added: true}`, or `{added: false, reason: "full"}` when the tray is full.
- **None of these** opens catalog search and sends `lockOutcome {added: false, reason: "dismissed"}`. A search pick takes the explicit Edition the collector chooses (the Misses decision; a Printing with no active Edition cannot be picked), not the starting Edition.
- Technical gap, resolved consistently with D8: when the route fails for a suggestion, the scanner shows the offline hint and sends `lockOutcome {added: false, reason: "offline"}` rather than suggesting from the cached card table. A pick must resolve an Edition anyway, so showing candidates that cannot be added would be worse than saying so.
- Offline, rows in an opened tray render from the cached number table; chips and confirm are disabled; the printings call retries on `online` and whenever the tray reopens. A row is marked as needing a finish only by a successful answer, never by an outage.

### Device storage and the Scan Tray ([D9](wayfinder/resolutions/decide-scanner-plumbing.md#d9-device-storage-cache-storage-for-blobs-localstorage-for-the-tray), [D10](wayfinder/resolutions/decide-scanner-plumbing.md#d10-tray-identity-versioning-and-accounts))

- **Blobs** (models, dictionary, fingerprints, number table) live in Cache Storage under content-addressed URLs, verified before they are stored. The runtime glue and wasm use the HTTP cache.
- **The tray** is `localStorage`, key `prizecheck:scanner:tray:v1:<userId>`, with a version field. It holds Printing ids, Edition ids, counts, up to three candidate Printing ids per row, a needs-pick flag, the destination and a pending-save record. It holds no names, images, prices, scores or photos. The [storage schema](wayfinder/resolutions/decide-scanner-plumbing.md#tray-storage-schema-localstorage-key-prizecheckscannertrayv1userid) is the contract.
- **Concurrency.** Every read-modify-write runs inside a Web Lock; other tabs re-read on the `storage` event.
- **Caps.** At most 200 distinct Editions, 400 rows, 999 copies a row and 9999 copies per Edition summed across rows. One pure function, `trayEditAllowed`, checks every edit (lock, suggestion pick, chip change, search pick, needs-pick resolution, count increase) before writing.
- **Eviction.** iOS Safari may delete the tray after 7 days without opening PrizeCheck or under storage pressure. The owner accepted this with no note in the UI. The app asks for persistent storage once after the first row.
- **Accounts.** Per user id. Signing out does not clear the tray.
- **Pending save.** While a confirm's outcome is unknown, the tray is read-only. A retry uses the same key and items.

### Stale Editions ([D11](wayfinder/resolutions/decide-scanner-plumbing.md#d11-stale-editions-cannot-hurt-the-collector))

The printings route marks a row as needing a pick on tray open when its Printing is missing or its Edition is no longer active. The row keeps its old Edition in storage but shows no chip selected, and confirming stays disabled until the collector picks (prototype verdict P2: in place, with a banner and **Show**). The server's `EDITIONS_CHANGED` at save marks exactly the affected rows.

### The save route ([D12](wayfinder/resolutions/decide-scanner-plumbing.md#d12-save-route-its-own-route-import-shaped))

`POST /api/scanner/save` takes `{ location_id, idempotency_key, items: [{ edition_id, quantity }] }` (at most 200 items; the tray merges rows that resolve to one Edition first) and returns `{ location_id, edition_count, copy_count, owner_revision }`, with no undo id.

- In one transaction it checks the destination is the collector's Storage Leaf with no children and not a Deck, checks every Edition is active, adds one Holding increment per Edition and advances the owner revision once.
- It starts no catalog pull and no price work, and touches only `holding`, `inventory_owner`, `mutation_request` and `move_response`.
- The receipt lasts 30 days, so a retry with the same key and items replays the first result.
- Refusals and the client's response to each are in the [refusal table](wayfinder/resolutions/decide-scanner-plumbing.md#refusal-table-for-post-apiscannersave): `IDEMPOTENCY_KEY_REUSED`, `REPLAY_OUTCOME_UNAVAILABLE`, `DESTINATION_CHANGED`, `EDITIONS_CHANGED`, `QUANTITY_OVERFLOW`, `INVENTORY_TEMPORARILY_UNAVAILABLE`.
- It does not reuse `POST /api/holdings/batch` or the import save, and never creates or replaces a Collection Import draft.

### Other API routes (all signed-in, owner-scoped, none public)

See [Contracts](wayfinder/resolutions/decide-scanner-plumbing.md#contracts) for shapes.

- `GET /api/scanner/manifest?model=<id>` tells the device the current number table and fingerprint file. `fingerprints: null` means no artifact for the app's model: the scanner shows the "no camera" screen.
- `GET /api/scanner/cards/{key}` returns the number table ([D5](wayfinder/resolutions/decide-scanner-plumbing.md#d5-the-number-table-is-built-by-the-api-on-request)): built by the API, deterministic gzip, delivered as an attachment so the gateway streams it unchanged.
- `GET /api/scanner/fingerprints/{sha256}` returns the fingerprint file ([D4](wayfinder/resolutions/decide-scanner-plumbing.md#d4-the-fingerprint-index-is-catalog-data-built-by-a-separate-job-image-stored-in-postgresql-served-behind-sign-in)), signed-in only.
- `POST /api/scanner/printings` resolves up to 100 Printing ids to display data and each Printing's starting Edition, and lists missing ids ([D8](wayfinder/resolutions/decide-scanner-plumbing.md#d8-candidates-resolve-to-editions-live-through-one-batch-route)).
- A set-totals table filled at catalog promotion and backfilled once ([D6](wayfinder/resolutions/decide-scanner-plumbing.md#d6-set-totals-get-a-structured-table-from-the-card-records)).
- A device caches the new index in the background and swaps it between frames ([D7](wayfinder/resolutions/decide-scanner-plumbing.md#d7-index-staleness-model-mismatch-and-printings-without-art)); a Printing with no reference art is matched by number or search only.

### The fingerprint index job ([D4](wayfinder/resolutions/decide-scanner-plumbing.md#d4-the-fingerprint-index-is-catalog-data-built-by-a-separate-job-image-stored-in-postgresql-served-behind-sign-in))

A separate job image builds the int8 fingerprint file from the catalog's reference artwork, stores it in PostgreSQL, and publishes at most two artifacts per model. It is a portable job run by the operator after catalog pulls; no scheduler is installed (ADR 0002). It writes no image bytes to disk or the database, rate-limits its fetches and identifies PrizeCheck in its User-Agent. A model change is a new model id; build the new artifact first, then deploy the web image.

### Web and delivery

- **The scanner is its own page.** It is a separate Vite multi-page HTML entry (for example `scan.html`), served at `/collection/scan` by its own nginx location with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (the resolution's fallback F3). `ScannerPage` is mounted only by that entry. This replaces D13's lazy page in Collection's sections ([D13](wayfinder/resolutions/decide-scanner-plumbing.md#d13-bundle-and-code-boundaries) otherwise stands).
  - The shell keeps no in-app route that renders the scanner; it only builds the link (a small route module exporting `SCANNER_PATH`, as `collectionImport/route.ts` does).
  - Every way in uses a full navigation (`location.assign`), never client-side routing: **Scan cards**, Collection Import's Camera source and the phone header shortcut. So do the scanner's Close and the return after Confirm.
  - The scanner entry reads `/auth/session` on the existing session cookie, as `web/src/main.tsx` does, and takes the tray key's user id from it. Signed out, it calls `location.assign("/collection")`, which shows the app's signed-out screens; there is no return to the scanner afterwards.
  - The Vite dev server serves the scanner entry at `/collection/scan` through a small middleware or plugin (Vite otherwise falls back to `index.html` for that path), and sets COOP and COEP on that document and COEP on worker and module URLs, so the browser stacks that run on the dev server (`docs/agents/verification.md`) get isolation.
  - The bundle-boundary check covers both entries' static graphs: the main entry must not reach the runtime, worker or `ort.ts`; the scanner entry is the only one that does.
  - **Header scope.** COOP and COEP are sent on the scanner's HTML document and on no other HTML document. `Cross-Origin-Embedder-Policy: require-corp` is also sent on `/assets/` responses and repeated in the nested `.mjs` location (nginx does not inherit `add_header` into a nested location), because the recognizer worker script and ORT's threaded `.mjs` glue are loaded by the isolated page and must carry COEP themselves. COEP on a non-document response has no effect on the main app.
- **Consequences the build must handle:**
  - every `<img>` in the scanner, including search results and candidates, carries `crossorigin="anonymous"` (TCGdex sends `Access-Control-Allow-Origin: *`);
  - the tray and the signed-in session survive the navigations because both are same-origin storage;
  - the scanner needs camera permission for its own origin; the current deployment sets no `Permissions-Policy` header, and if one is added it must keep `camera=(self)` (the resolution's CSP note in D13 applies as well).
- **Static assets.** nginx gzips the `.wasm` in `/assets/`, serves `/scanner/m/` with immutable caching and gzip for the model files, and answers `text/javascript` from a nested `.mjs` location ([D3](wayfinder/resolutions/decide-scanner-plumbing.md#d3-models-are-static-assets-in-the-web-image-pinned-by-sha256-fetched-at-image-build)). The gateway's binary attachment pass-through is pinned by a test, with no gateway change.
- **Camera.** `getUserMedia` needs HTTPS; the Unraid deployment is HTTPS through Tailscale Serve, and phone tests must use an HTTPS origin.
- **Screens** follow the [prototype](wayfinder/prototypes/scan-tray/README.md) and its owner verdict. Build them on the app's components and tokens, not the prototype's markup.
  - **Entry points:** Collection's phone row reads Add cards, Scan cards, Import…, Select, plus the camera button in the header (both kept). Collection Import's Camera choice has Start scanning and hides Put cards in and Review import.
  - **Getting ready:** the heading and the progress bar only, no extra line. A warm open (assets already cached and verified) shows the same view with no progress bar until the camera is ready.
  - **Cannot start:** one screen with **Search for cards**, **Import from another tracker**, **Try again** and, if the tray holds cards, **Review tray**. It names a cause only when the collector can act on it: no camera, camera permission denied (with how to allow it), or an unsupported browser. A failed or interrupted first download, a sha256 mismatch, a storage quota error on `cache.put`, no index built, and worker `INIT_FAILED` or `ASSET_INVALID` all show the one generic screen and never mention the index, the download or assets. **Try again** restarts the asset load and worker.
  - **Camera:** full screen with Close, a sound toggle, the guide, the hint pill (shown only for camera hints, lock outcomes and offline), the shutter and the tray peek.
  - **Tray sheet:** peek of about 136 px (handle, "Tray", the total, **Review**, the last-touched row) and an open detent at 85% of the height that pauses scanning. There is no confirm in the peek.
  - **Rows:** one-tap finish chips, a stepper (the minus becomes a bin at 1), **Change card**, **Clear tray**, a **Put cards in** picker of Storage Leaves that are not Decks, and **Add N cards to <Location>** (the prototype shows the Location's path; the displayed form is the Location's path where the app shows one elsewhere, and this spec writes `<Location>`).
  - **Reuse:** the tray reuses the import review's candidate and search components and `PrintingView` data. It uses one-tap finish chips, not the import's finish menu. `web/src/ui/Chip.tsx` is a toggle (`selected`, `onChange`); the finish-chip row is a new single-choice component built on it in the tray slice (a tap on the selected chip does nothing).
  - **Confirm:** lands on the destination's Collection with the toast and no Undo.
- **Asset loader.** One module on the main thread (its own slice) fetches the manifest on every open, downloads and verifies each asset (sha256 for models and fingerprints; length plus parse for the number table) before `cache.put`, handles a quota error as a failed start, swaps a newer index in the background between frames, computes the progress total from the lock file and manifest, and calls `navigator.storage.persist()` once after the first tray row.
- **Sound setting.** The lock-sound toggle is a device setting kept in `localStorage`, off by default (technical gap, resolved: it is not part of the tray or the account).
- **Copy** never shows scores, tiers, model or source names, index or model versions, hashes, catalog revisions, fetch times, prices, or download state beyond "Getting the scanner ready" with a bar (AGENTS.md, [D14](wayfinder/resolutions/decide-scanner-plumbing.md#d14-ui-copy)). Hint and message wording is in [Copy](#copy).

### Copy

All wording below is final: the owner approved the strings the resolution (D8, D12, D14) left for the spec and those drafted here on 2026-10-25.

| Where | Text | Status |
|---|---|---|
| First download | Getting the scanner ready | Final (owner, 2026-10-22) |
| Scan Suggestion button | None of these | Final (owner, 2026-10-24) |
| Unanswered save past 29 days | This tray may already be in your Collection. Check before confirming again. | Final (owner, 2026-10-22) |
| Stale rows banner | N rows need a finish before you can add them. | Final (prototype, owner verdict) |
| Stale rows footer | N rows need a finish. | Final (prototype, owner verdict) |
| Lock could not be added | Couldn't add this card. Tap the shutter to search. | Final (owner, 2026-10-25) |
| Offline at lock | Can't reach PrizeCheck. Check your connection and scan again. | Final (owner, 2026-10-25) |
| Edition limit | That's the most copies of one card in a tray | Final (owner, 2026-10-25) |
| Dark hint | More light | Final (owner, 2026-10-25) |
| Blurry hint | Hold steady (not shown until the sharpness retune) | Final (owner, 2026-10-25) |
| Bright hint | Less light | Final (owner, 2026-10-25) |
| Glare hint (`clipped`) | Tilt to avoid glare | Final (owner, 2026-10-25) |
| Full tray | The tray is full. Add these cards to your Collection before scanning more. | Final (owner, 2026-10-25) |
| Suggestion heading | Is it one of these? | Final (owner, 2026-10-25) |
| Warm open | "Getting the scanner ready" with no progress bar | Final (owner, 2026-10-25) |
| Cannot start | heading "The scanner can't start", then, only for a camera or browser cause, the reason and how to allow the camera; the actions in story 7 | Final (owner, 2026-10-25) |
| Confirm toast | Added N cards to <Location> | Final (owner, 2026-10-25) |

## Testing Decisions

### What makes a good test

A good test checks what a collector or caller can observe: a route's status and body, Holdings after saving, what the tray shows, the vote outcome for a scripted sequence of frames, visible text, roles and focus. It does not assert module names, SQL or CSS classes. The [resolution's test strategy](wayfinder/resolutions/decide-scanner-plumbing.md#test-strategy) is the test plan and is not repeated here. This section adds what the decisions above change.

### Fixture rule

No Pokémon card artwork is committed anywhere in the repository, including fixtures, test images, fake-camera clips, screenshots and baselines. Every committed scanner fixture is synthetic: card-shaped rectangles in flat colours with numbers and set codes drawn from a bundled open font. Fixtures needing real art (embedding parity against the real index, the owner's cards) run only locally and are git-ignored. `scripts/make_scanner_fixtures.py` regenerates the committed fixtures deterministically and fails if they exceed 2 MB.

### Additions to the resolution's plan

- **Voting (vitest), with the eligibility and suggestion rule:**
  - frames with no found corners and no OCR candidate do not count toward a lock or a suggestion, and a long run of them produces no event (the empty-table case);
  - 3 of 4 eligible frames agreeing with a number-backed pick give an automatic lock;
  - 3 of 4 agreeing with no frame number-backed give a `suggest` event with up to three Printing ids, and no row;
  - an OCR candidate for a different Printing than the agreed one does not back the lock, so the result is a suggestion;
  - a `dismissed` outcome needs an absence before the next event and has no 2 s pause, and a picked suggestion behaves like `added: true`;
  - `unresolved` or `offline` after a `suggest` empties the window and re-arms after 2 s;
  - the worker posts `absent` for a pending `suggest` lock when the card leaves the guide;
  - a pending lock or suggestion blocks new events until its outcome;
  - the shutter still locks and still posts `miss`, and does nothing while a suggestion is pending.
- **Gate:** with sharpness off, a sharp-or-soft frame passes; dark, bright and clipped frames still fail with their reasons.
- **Threads:** the worker picks `Math.min(4, navigator.hardwareConcurrency ?? 1)` when isolated and 1 when not (unit test with a stubbed `crossOriginIsolated`). A browser test asserts `self.crossOriginIsolated` is true inside the recognizer worker, not only on the page.
- **Absence:** `absent` fires once per pending `lockId`; after `dismissed` the voter is locked and needs a fresh absence before it re-arms.
- **Recognition module interface:** a stub recognizer that satisfies the message contract drives the tray and save path end to end, so the tray tests do not depend on the real models. A test pins that nothing but `worker/ort.ts` imports the runtime.
- **Tray and settings (vitest):** the lock sound is off by default.
- **Collection Import's Camera choice** opens the scanner by full navigation and never calls `POST /api/collection-imports` (browser test with a request spy).
- **API (pytest):** the save, printings, cards, manifest, fingerprints, set-count and index-job tests in the resolution. They add nothing for suggestions: a suggestion is entirely a client matter, and its pick uses the printings and save routes.
- **Browser (Playwright, frame injection):** extend `scanner-tray.spec.ts` with:
  - a scripted image-only sequence shows a Scan Suggestion with three candidates, adds no row until one is picked, and the picked card enters the tray with its starting finish selected;
  - **None of these** opens search, and the same card is not suggested again until a scripted absence;
  - a number-backed sequence adds a row with no question;
  - a scripted run of no-card frames adds nothing and shows no suggestion;
  - the cannot-start screen: denied camera and an unsupported browser name their cause; a failed asset load, a hash mismatch and no index built show the generic screen, which does not contain the words index, download or asset;
  - the scanner is opened through **Scan cards** (a full navigation) and then `crossOriginIsolated` is true, its images load, and no COEP console errors appear; Close and the return after Confirm are full navigations;
  - the stub script's frames gain `eligible?: boolean` (default true) and `ocr?: string[]` (the frame's OCR number candidates, Printing ids). `textBacked` derives from `ocr` containing `top[0]`. The stub otherwise keeps the resolution's shape (`url`, `gate`, `top`);
  - the rest of the plan is as in the resolution (second placement, shutter `miss`, unreachable printings route, persistence across reload, a second collector, no image bytes in any request body, save, `EDITIONS_CHANGED`, `DESTINATION_CHANGED`, replay, frozen tray, fallback screens, fake-camera smoke test).
- **Phone width and accessibility:** no horizontal scroll, 44 px controls, announced hints, suggestion, chips and disabled confirm, and focus moving into and out of the tray, suggestion and search.
- **Tooling:** the bundle-boundary, proxy-config (`.mjs`, gzip, `/scanner/m/`), guardrail and `fetch-scanner-models.mjs --check` tests in the resolution. Changes: the bundle-boundary test covers both entries' graphs (main must not reach the runtime); add proxy-config tests that the scanner location sends COOP `same-origin` and COEP `require-corp`, that no HTML document other than the scanner's gets COOP or COEP, and that `/assets/` and its nested `.mjs` location send COEP `require-corp`; add a check that the Vite dev server serves the scanner entry at `/collection/scan` with the same header scope.

### Checks that need a person and a phone

These run once on the deployed dev site and are recorded in the launch checklist, not in CI:

- cold download bytes, `content-encoding: gzip` on `.wasm` and `.onnx`, `text/javascript` on the `.mjs` glue, `application/wasm` on the wasm (G6);
- a lock run with the owner's cards on the iPhone, with a bare-table stretch, confirming no phantom lock and noting how often cards produce a Scan Suggestion instead of a lock;
- the shipped gate setting (sharpness off, dark, bright and clipped on) in dim light and on foils.

## Open Questions

None. The owner answered the four collector-facing questions on 2026-10-25: a card taken out with its Scan Suggestion unanswered is skipped; a suggestion gets no lock cue; the shutter adds an image-only match but is greyed out while a suggestion shows; and every drafted string in the Copy table is approved.

## Out of Scope

- Uploading or storing card photos, server-side recognition, and syncing the tray across devices.
- Non-English cards, sealed product, graded slabs and other games.
- Prices or values while scanning.
- Recognising a finish, condition, grade or stamp from the image.
- Undo after confirming.
- Adding cards to a Deck from the scanner (a Deck is not a destination).
- Tuning, replacing or speeding up recognition. See [Deferred recognition work](#deferred-recognition-work).
- A native app wrapper. The owner plans an App Store release after the web product is deployed, likely a wrapper where only the scanner is a native plugin; it is not part of this spec.
- Laptop webcam tuning. Webcams work but are not tuned for, or counted in, the accuracy bar.
- A public launch of the scanner (see Ship blockers).
- Publishing, committing or shipping the spike's gate harness.

## Further Notes

### Deferred recognition work

The owner decided on 2026-10-24 to ship the scanner now and improve recognition afterwards. These are follow-ups, each landing as a replacement behind the recognition module interface. None blocks the first release.

- **Sharpness gate retune on real camera frames.** The shipped threshold (5333) came from synthetic images and rejected 85 to 96 percent of real frames (real sharpness p10 2585, p50 3953, p90 5122). The phone runs bypassed it. The first release ships with the sharpness check off (see "Recognition decided by the primary" above).
- **Speed pass.** At 4 threads the gate run was 393 ms p50 per gated frame (bar 300 ms) and time to lock p50 2.96 s (bar 1.5 s). Corner finding at 92 ms is the largest non-model cost, then warp (29 ms), frame read (13 ms) and the gate (14 ms; its p90 with the read was 31 ms against a 15 ms bar). Faster ports, WebGPU with an fp16 embedder (about 90 ms model time, estimated, +32 MB) and a native plugin are the larger options.
- **G7 memory:** peak memory over 5 and 10 minutes and crashes, on iOS Safari and Android Chrome. Unmeasured.
- **G9 voting:** double counts, missed second copies, wrong-Printing locks and false absences. Unmeasured, and the harness did not advance placements by itself.
- **Slower phones and Android.** Only one fast iPhone (iPhone 17 Pro Max, iOS 27.0.1) was measured. The first release is not verified on a slower iPhone or any Android phone.
- **G10 on the full 30 cards** through the phone pipeline.
- **Accuracy levers from the spike,** in order: read the number strip from the full-resolution frame; corner finding that tolerates protector rims; link reprints in the catalog so twins appear together.

### Ship blockers

From the [resolution](wayfinder/resolutions/decide-scanner-plumbing.md#ship-blockers), as amended by the owner's ship-first decision.

1. **Fingerprint rights.** The artwork index is derived from TCGdex artwork, which is The Pokémon Company's copyright. The scanner is built and used only on the private, sign-in-only deployment, never stores images and never publishes the index. A public launch waits for a written rights check. This stays a blocker for any public launch, not for the private one.
2. **Phantom-lock fix present** in the port (the eligibility rule above), checked on a phone with a bare-table stretch.
3. A scanner index has been published once for the shipped model id, and the job is wired to run after catalog pulls in the target deployment.
4. CI and the deploy workflows build and push the index job image, and the compose service exists.
5. The web image carries the verified models; nginx `/scanner/m/` and the scanner document's COOP and COEP headers and COEP on `/assets/` and the nested `.mjs` location are in place; gzip and the `.mjs` type are verified on the deployed site (G6).
6. Set counts are backfilled for the active generation before the scanner routes are reachable in that environment.
7. An HTTPS origin for every phone.
8. The index job's request rate and User-Agent are recorded in `docs/deployment-boundaries.md`.

G0 (the int8 index and `set_codes.tsv` rerun of the 30-photo set) passed on 2026-10-22: top-1 21 of 30 and top-3 25 of 30 against bars of 19 and 24 (spike `reports/g0-int8-parity.md`).

Resolution blocker 2 (the gate passing or ending in a recorded fallback) is replaced by the owner's decision above: G2, G3 and G4 missed, were accepted, and are follow-ups.

### Owner answers this spec rests on

Dated, in the map's "Decisions so far": review tray; on-device only; accuracy bar (measured on the full pipeline later, not claimed met); English only; automatic capture with a shutter fallback; guide outline; finish default; one Storage Leaf destination and no Deck; unfinished tray kept on the device, per account; entry points; no prices; misses to search; lock feedback; repeat lock; no undo; tray cap; iOS eviction accepted; first download; stale save note; no index built; image-only matches as a Scan Suggestion with the top three and **None of these** to search (2026-10-23 and 2026-10-24); a card taken out with its suggestion unanswered is skipped, and a suggestion gets no lock cue, and the shutter adds an image-only match but is greyed out while a suggestion shows (2026-10-25); ship first, improve later (2026-10-24); fingerprint rights; the tray prototype's eight answers (2026-10-22).

The accuracy bar (the right card in the top three at least 9 in 10 and first at least 7 in 10) was not met by the spike on Mac figures (20/30 first, 25/30 in the top three) and was not re-measured on the owner's cards on phones. The owner accepted this on 2026-10-22 and 2026-10-24.

### Branch and tickets

Work goes on `feature/card-scanner`, cut from `dev`. Tickets close on the release to `main`, as with other features. No GitHub issues are filed by this spec; ask before creating any, or a `feature: card scanner` label.

### Proposed slices

Filed on 2026-10-26 under [#308](https://github.com/ry-cen/prizecheck/issues/308) as #309 to #321, in this order. Each is a thin, testable vertical piece; dependencies are listed. They follow the resolution's six work packages and add the pieces the later decisions created.

1. **Catalog data: set counts and index tables.** Migration for the set-counts table, the fingerprint, index and failure tables; fill at catalog promotion; the backfill script. Tests: majority rule, idempotent backfill.
2. **Scanner API.** `api/app/scanner.py` with the manifest, cards, fingerprints and printings routes, `default_edition`, the generated client, and the gateway's binary pass-through test. Depends on 1.
3. **Scanner save route.** `POST /api/scanner/save` with its refusals, 30-day receipt and replay tests. Depends on 2's module.
4. **Index job.** The job script, its image and compose service, CI and deploy workflow changes, with stubbed embedder and fetcher tests. Depends on 1, and on 5 for the model lock file it reads. Can run beside 2 and 3.
5. **Delivery: models, nginx, the scanner entry and tooling.** The model lock file and fetch script, Dockerfile step, `/scanner/m/` and `.mjs` nginx rules, gzip, the scanner's own Vite HTML entry with its nginx location and COOP and COEP headers, COEP on `/assets/` and the nested `.mjs` location, the Vite dev server middleware or plugin that serves the entry at `/collection/scan` with the same header scope, the entry's bootstrap (`/auth/session`, `location.assign("/collection")` when signed out, user id), bundle-boundary checks over both entries and the guardrail, `docs/deployment-boundaries.md`. Can run beside 2 to 4.
6. **Vision port.** The hand-written image primitives under `web/src/scanner/vision/` and their parity fixtures, from the spike at `4e3d827`. Can run beside 2 to 5.
7. **Recognition module and worker.** The pipeline, number table and fingerprint readers, OCR decode, combiner, voting with the eligibility and suggestion rule, the worker, `ort.ts` and the message contract with the `suggest`, `dismissed` and `absent` amendments, the gate with sharpness off and the worker-chosen thread count, behind the module interface. Depends on 6. A stub recognizer for the browser tests is part of this slice.
8. **Tray store and save flow.** The `localStorage` store, caps and `trayEditAllowed`, per-account keys and locks, pending save and the 29-day rule, stale marking. Depends on 2 and 3's generated client.
9. **Asset loader.** The main-thread module that fetches the manifest, downloads and verifies assets, puts them in Cache Storage (handling quota errors), swaps a newer index in the background, computes progress totals and calls `persist()`. Depends on 2 and 5. Can run beside 7 and 8.
10. **Scanner screen.** The camera page: capability check, the first-download and warm-open views, the cannot-start screen, the guide, hints, lock cue and sound setting, the tray sheet and its rows (with the new finish-chip row), stale rows, destination picker, full-tray and clear dialogs, confirm and landing by full navigation. Until slice 11 lands it answers every `suggest` lock with `lockOutcome {added: false, reason: "dismissed"}`, so recognition never stalls. Depends on 5, 7, 8 and 9.
11. **Scan Suggestion UI.** Presentation, pick (as a lock of the chosen Printing), **None of these**, the `absent` handling (skip the card) and the dismissed outcome. Depends on 10.
12. **Entry points.** **Scan cards** in Collection, the phone header button, and the Camera choice in Collection Import, each a full navigation (`location.assign`) to `SCANNER_PATH`. Depends on 5; useful once 10 lands.
13. **Browser and phone checks.** Frame injection fixtures (with `eligible` and `ocr`), the browser specs, the fake-camera smoke test, and the deployed-site checks for G6, the bare-table run and the shipped gate setting. Depends on the rest.

The ADR "On-device recognition assets and the scanner index job" (map ticket 6, covering D3, D4 and D9) is separate from these slices.

### Risks

- **Speed and sustained use are unproven beyond one fast iPhone.** The first release may feel slow on other phones, and the per-frame time budget is exceeded even on the tested one. The recognition module interface limits the cost of fixing this.
- **The shipped gate setting was never run on a phone.** Every phone run bypassed the whole gate. The shipped setting (sharpness off, dark, bright and clipped on) is new code, and its luma floor (40) sits close to the luma of a card on a dim table (49 or more was measured). It could reject real frames in dim light or flag foils as clipped. The deployed-site check covers dim light and foils.
- **The isolated scanner page is a new delivery shape** (its own HTML entry, full navigations, COEP on every image). It is the likeliest source of surprises on the deployed site and is covered by the browser and deployed checks.
- **Suggestions may be common.** Image-only agreement is how many real cards will match until the gate and speed work land. The Scan Suggestion presentation matters more than the lock cue for how the scanner feels.
- **Rights.** See ship blocker 1.

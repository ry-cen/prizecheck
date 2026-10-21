# Recognition spike — brief

**Map:** [Card scanner decision map](../../map.md)

**Status:** not started. Waiting on the owner's test photos.

## Question

Can a browser, on a phone, recognize English Pokémon cards well enough to meet the owner's accuracy bar, without sending any image off the device? If so, which method is enough: OCR of the collector number, image matching against reference fingerprints, or both combined?

**The bar** (owner, 2026-10-21): across the test set, the right card is among the top 3 candidates for at least 90% of cards, and is the first candidate for at least 70%. The right card means the right Card Printing (the right TCGdex card); finish is not scored, because the tray never guesses it.

## Where it lives

A separate throwaway repository, not this one. It may use Python, ML tooling and large reference files that do not belong in the app. Only a findings note comes back, saved as `docs/planning/card-scanner/wayfinder/research/recognition-spike-findings.md`. The test photos never leave the owner's machine and are never committed anywhere.

## Test set

About 100 photos of the owner's own cards, taken with a phone camera in ordinary conditions:

- current sets and older sets, holo and reverse holo, full art, promos;
- basic energies and trainer-kit cards, which have no reference artwork in TCGdex;
- some in penny sleeves and some in top-loaders, some with glare, some at an angle, some on a busy background;
- a few reprints that share artwork with another Printing.

Each photo is labelled by hand in one CSV next to the photos, with the set code and collector number as printed on the card (for example `SVI 025/198`). The spike maps those labels to TCGdex card IDs.

The spike gets the English catalog and the reference artwork from the public TCGdex API (`api.tcgdex.net/v2/en`), which is what PrizeCheck's catalog is built from. It does not need PrizeCheck's database.

## What to build

1. **Card finding.** Find the four corners and straighten the card to a fixed size. Record how often this fails, because every method depends on it.
2. **OCR.** Read the collector-number strip, limited to digits, letters used in promo numbers, and `/`. Look the result up in the catalog. Try Tesseract.js-class OCR first; try one stronger model (PaddleOCR through ONNX Runtime Web, or similar) if it falls short.
3. **Image matching.** Build fingerprints from TCGdex reference artwork for the English catalog with a small image-embedding model. Rank by nearest neighbor. Try one model small enough for a phone browser.
4. **Combined.** Use the number to narrow the candidates and the image to order them; fall back to image alone when OCR returns nothing.
5. **Frame voting.** For a few short phone videos, check whether voting across frames improves top-1 over a single frame.

The ranking and accuracy work can run in Python first. Speed and download size must be measured in a phone browser.

## What to report

- Top-1 and top-3 accuracy for OCR alone, image alone and combined, overall and for each group in the test set (energies, reprints, sleeved, glare, older sets).
- How often card finding fails.
- Download size for each method: OCR engine and data, embedding model, fingerprint index (also say how big the index is at the precision used).
- Time per frame on a recent iPhone and on a mid-range Android phone, in Safari and Chrome.
- A recommendation: which method the first version ships, and whether image matching earns its download.
- What would need to change to reach the bar if no method does.

## Out of scope

Finish, condition or stamp recognition; non-English cards; any server-side recognition; the tray UI.

# Recognition spike — findings

**Map:** [Card scanner decision map](../map.md)
**Brief:** [Recognition spike brief](../prototypes/recognition-spike/brief.md)
**Date:** 2026-10-22

## Result

Image matching plus number OCR, combined, came close to the accuracy bar on real photos but did not meet it. On the fresh set of 30, the right card was first for 20 (bar: 21) and in the top 3 for 25 (bar: 27). The owner stopped the spike there on 2026-10-22 and accepted the result (see Decision). Speed on phones was not measured.

## What was built

A Python pipeline, run on a Mac, not in a phone browser. The code is in a local repository (`~/dev/prizecheck-scan-spike`). Nothing is published.

1. A card-shaped guide outline that the collector lines the card up inside.
2. A sharpness gate.
3. Guided corner finding and straightening.
4. Number OCR of the collector-number strip: PaddleOCR v5 English recognizer through ONNX Runtime, run on 4 crops of the number area. It was tried after a Tesseract-class approach fell short. Results are matched against set totals, including a rule for numbers glued to the copyright year.
5. Image fingerprints: DINOv2-small (int8 ONNX), nearest neighbor over 19,659 TCGdex reference images. The catalog has 21,256 cards; the rest have no reference art.
6. A combiner. The number narrows the candidates and the image orders them. When the image strongly disagrees with a low-confidence number read, it falls back to the image. A fix on 2026-10-21 keeps a confident number read in the top 3 beside the image's choice, instead of dropping it.

## Test sets

- **Synthetic** (development only, never scored against the bar). On the held-out realistic tier, 2,000 images per tier: combined 98% top-1 and 99% top-3; image alone 96% top-1; OCR read the number on 70%; clean references 87–88%. Image scores here are circular, because the images are matched against the same reference art.
- **Real photos.** The owner's own photos were not used. Instead, two sets of 30 eBay seller photos, labelled by the printed set and number and checked against the printed number where reprints exist. The guide was simulated: set 1 used automatic alignment plus hand-placed card boxes for 12 photos; set 2 used hand-placed card boxes for all 30. The photos are not committed anywhere.

## Real-photo results

Set 1 was scored three times while developing, so it is optimistic. Set 2 was a fresh batch scored exactly once. It is the honest number.

| Method | Set 1 top-1 | Set 2 top-1 | Set 2 top-3 |
| --- | --- | --- | --- |
| Combined | 24/30 | 20/30 (bar 21) | 25/30 (bar 27) |
| Image alone | 20/30 | 17/30 | 24/30 |
| Number OCR alone | 8/30 | 5/30 | 11/30 |

Set 1 combined top-3 was 24/30. The sharpness gate rejected 0 photos in set 2.

Why set 2's 10 first-pick misses happened:

- **4 reprints sharing art with another Card Printing**, each ranked 2nd behind its twin: Base Set 2 Nidoking, Fossil Hypno, XY Evolutions Charizard, Team Rocket Machop.
- **2 Celebrations Classic Collection cards.** TCGdex has no reference art for them, and their printed numbers match the originals (2/102, 15/102). They cannot be recognized today.
- **4 misses with no number read:** a full-art trainer in a top-loader, two cards where corner finding fell back to the guide crop, and a card in a sleeve held in hand.

Without the 2 Celebrations cards, which the scanner cannot fix, top-3 is 25/28.

The set 2 breakdown above is by miss cause. The brief's other groups (energies, glare, older sets) are not reported separately.

**Card finding failures.** A failure rate on the real photos was not recorded; two set 2 photos are known to have fallen back to the guide crop. On the synthetic sets, one tuning run on the dev split put guided corner failures at 26/306 (8.5%) for the realistic tier and 117/217 (54%) for the protected tier, where the finder locks onto the protector rim.

**Protected cards.** Number OCR read 5 of 30 overall and 2 of 11 top-loaders. On the synthetic protected tier (top-loaders, sleeves, magnetic cases), OCR read 53% with automatic corners against 84% with true corners; magnetic cases read 24%. Corner finding is the weak step for protected cards.

**Framing sensitivity.** With the guide 12% larger, as if the collector lined up the top-loader instead of the card, combined top-1 fell from 20 to 10.

## What was tried and did not work

- Two attempts to make corner finding prefer the card's edge over the plastic rim both failed their checks and were closed. Version 1 misread textured card regions as rims. Version 2 rarely fired, because the rim and card lines are too close together.
- 18 OCR preprocessing variants (padding, contrast, tolerant parsing). None gained 3 points; padding hurt.

## Size and speed

- **Download, about 40 MB in total:** embedding model 24.4 MB, fingerprint index 7.6 MB (int8; 384 dimensions × 19,659 cards), OCR model 7.8 MB. Image matching accounts for roughly 32 MB of that.
- **Speed:** about 69 ms per scan in Python on a Mac. Not measured on a recent iPhone or a mid-range Android phone, or in Safari or Chrome.

## Decision

Owner, 2026-10-22, after the second real-photo run: stop the spike and accept the result. The reprint and Celebrations cases are too niche to matter. The review tray, with catalog search on every row, covers the misses.

## Recommendation

- **Ship image matching plus number OCR combined.** Image matching earns its roughly 32 MB: it carries most hits, and OCR alone is far below the bar on real photos. The number still matters for reprints and for cards with no reference art.
- **The guide outline's copy must ask the collector to line up the card itself, not its case.**
- **If accuracy needs raising later, in this order:**
  1. Read the number strip from the full-resolution frame, not the downsized straightened card.
  2. Corner finding that tolerates protector rims. This needs a different design from the two tried.
  3. Link reprints in the catalog so twins appear together.

## Still open before the plumbing decision

- Time per frame and download on real phones, in Safari and Chrome.
- Frame voting (brief item 5) was not tested.
- Per-group results on the owner's own photos were never collected.
- A card-finding failure rate on the real photos.
- Fingerprint rights are unchanged: they stay listed under "Not yet specified" in the map.

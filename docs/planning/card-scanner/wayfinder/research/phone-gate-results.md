# Phone measurement gate — results

**Map:** [Card scanner decision map](../map.md)
**Gate definition:** [Measurement gate (map ticket 3)](../resolutions/decide-scanner-plumbing.md#measurement-gate-map-ticket-3)
**Date:** 2026-10-23

## Result

The gate did not pass. Speed (G2), the cheap gate's cost (G3) and time to lock (G4) all missed their bars on the one phone tested; G7 (memory) and G9 (voting) were not run. The owner ended the session after the Lock run and accepted building on the current runtime anyway (see Decision). Accuracy through the phone pipeline was good on the small sample (21 of 22 first, 21 of 22 in the top 3).

## What was measured

- **Device:** iPhone 17 Pro Max, iOS 27.0.1, Safari 27.0.1. No Android phone, no slower iPhone.
- **Camera:** Back Triple Camera, zoom 1, 1080x1920 at 30 fps.
- **Runtime:** the plumbing's choice: WASM with 4 threads (the page served cross-origin isolated, fallback F3), the int8 embedder, Paddle OCR on 4 crops. `hardwareConcurrency` was 4.
- **Harness:** the spike repository's gate harness (`~/dev/prizecheck-scan-spike`, reports under `reports/gate/`). Speed and Lock runs had the sharpness gate bypassed, because the gate as tuned rejected nearly every real frame (see Findings). Nothing is published.

## Results

| Gate | Result | Bar | Verdict |
| --- | --- | --- | --- |
| Device parity against the Python reference (10 items) | top-1 9 equal plus 1 tie, top-3 9 of 10, cosine minimum 0.9932, all outlines and OCR texts equal; Mac Safari and iPhone gave identical numbers | no non-tie top-1 differences, top-1 at least 8, top-3 at least 7, cosine at least 0.99 | pass |
| G2 analysis per frame | p50 393 ms, p90 430 ms, 695 frames | p50 at most 300 ms, p90 at most 500 ms | fail (p50) |
| G3 cheap gate per frame | read plus gate p90 31 ms; gate alone p90 17 ms | p90 at most 15 ms | fail |
| G4 time to lock | p50 2.96 s, p90 4.10 s, 22 placements | p50 at most 1.5 s, p90 at most 2.5 s, 30 placements | fail on time; too few placements to count as a verdict run |
| G5 first ready, warm | p50 1.03 s, max 2.28 s, 10 valid runs | p50 at most 2.0 s, max 3.0 s | pass |
| G6 cold download | proxy only: 40.9 MB in 1.6 s on Wi-Fi | at most 45 MB on the deployed site | deferred |
| G7 peak memory | not run | at most 350 MB, no crashes in 10 minutes | unmeasured |
| G8 sustained speed | minute-5 p50 against minute 1: 1.16 | at most 1.5 | pass |
| G9 voting | not run | no double counts, at most 1 of 5 second copies missed | unmeasured |
| G10 accuracy through the phone | top-1 21 of 22, top-3 21 of 22, no unknowns | report only; stop below 18 of 30 and 24 of 30 | reported; not comparable to the bar (22 placements, not 30) |

Notes on the rows:

- **G2** with 2 threads: p50 451 ms (model 314 ms). Four threads helped but not enough.
- **G3** gate alone fell to 8 ms at 2 threads, so the 17 ms at 4 threads is contention with the model threads.
- **G4** follows from about 390 ms per frame times the number of agreeing frames needed to lock. No placement timed out.
- **G6** is a proxy. `vite preview` and `tailscale serve` are not the app's nginx, so the headers and the gzip check wait for the deployed dev site once the scanner's nginx changes reach it.
- **G10** is a small sample of the owner's cards, live, with the guide. It is above the spike's Mac figures, but 22 placements cannot settle the bar.

## Where the time goes

Per gated frame at 4 threads, p50 393 ms:

| Stage | ms |
| --- | --- |
| Model total | 225 |
| Embedding | 162 |
| OCR | 63 |
| Non-model total | 170 |
| Corner finding | 92 |
| Warp | 29 |
| Frame read | 13 |
| Gate | 14 |

The non-model work is 170 ms against the 75 ms the 300 ms budget left for it. Corner finding is the largest non-model item. The model time is close to the earlier fallback benchmark (about 225 ms for 4 threads and 4 crops). That benchmark also estimated WebGPU with an fp16 embedder at about 90 ms of model time, at about 32 MB more download and a separate fp16 fingerprint artifact (F4); it was not run in the gate.

## Findings and follow-ups

1. **Port speed.** Corner finding (92 ms), warp (29 ms) and the read and gate steps are the biggest levers. This is the speed pass.
2. **Sharpness gate tuning.** The gate's threshold (sharpMin 5333) came from synthetic images and rejected 85 to 96 percent of real camera frames. Real sharpness was p10 2585, p50 3953, p90 5122. Retune on real camera frames.
3. **Phantom locks.** With the gate bypassed, 16 locks happened with no card placed, 9 of them on Vermilion City Gym (gym1-120), usually just after the owner removed a card. This must be fixed before release.
   - **Cause.** The empty surface was dark and almost featureless: mean luma 12 to 19 against 49 or more with a card, sharpness about 120 against about 1,500. The tuned gate flags these frames `dark` and `soft`, but it was bypassed, so the pipeline ran on them. No corners were found in any of the 83 Vermilion frames (312 frames with a card did find them), so the pipeline fell back to the guide rectangle and embedded a near-black crop. Every blank frame is nearly the same image, its nearest fingerprint is Vermilion City Gym, and voting locks on 3 of 4 agreeing frames with no check that a card is present and no minimum score, so it re-locked about 5 s after each removal. The other 7 phantom locks were near-blank frames landing on other Printings.
   - **Fixes, in order.** (a) Only frames with found corners count toward an automatic lock; a frame on the guide fallback needs an OCR number match to count, and the shutter covers the rest. In this run that blocks all 83 Vermilion frames and no frame with a card. (b) Keep the gate's darkness check when retuning sharpness; it separates this surface cleanly, but a light table would defeat it, so it backs up (a) rather than replacing it. (c) A minimum similarity for image-only locks; the harness does not save per-frame scores yet, so record them in the next run before picking a value.
4. **Harness, not scanner.** Lock never auto-advanced; all 22 placements were advanced by hand with Next card. The harness's clear or absence detection does not fire on this setup. This is also why G9 cannot yet be run as written.

## What stays unmeasured

- G7: memory over 5 and 10 minutes, and crashes.
- G9: voting (double counts, missed second copies, wrong-Printing locks, false absences).
- G6 on the deployed site (headers, gzip, total bytes).
- Slower phones, and any Android phone with Chrome. The gate required both a recent iPhone and a mid-range Android, so every pass above is for one fast phone only.
- G10 on the full 30 cards.

## Decision

Owner, 2026-10-23: ended the gate session after Lock. The lock felt reasonable; the model and the port can keep improving later and be dropped into the app.

- The gate did not pass G2, G3 or G4, and the owner accepted building on the current runtime anyway: WASM, 4 threads under COOP/COEP, the int8 embedder and Paddle OCR. The fallbacks F1 to F6 were not applied.
- Recognition must sit behind a narrow module interface, so a faster port, a retuned gate, WebGPU or a native plugin can replace it without changing the tray or the save path.
- Follow-ups: the speed pass, the gate's sharpness retune on real camera frames, and stopping empty-scene phantom locks. Stopping phantom locks is required before release.
- Native: the owner plans an App Store release eventually, but only after the web product works and is deployed. The likely shape is a wrapper app (Capacitor-style) in which only the scanner is a native plugin: Core ML on the Neural Engine, Apple Vision for rectangles and text, AVFoundation for camera control. An estimate, unmeasured, is under 50 ms per frame. It is not part of this map.

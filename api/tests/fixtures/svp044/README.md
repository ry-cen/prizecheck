# Charmander SVP 044 product evidence

`products.json` is the unchanged three-product subset (477182, 512035, 512036) of the 280-product TCGCSV response fetched 2026-11-04 01:59:48 UTC from <https://tcgcsv.com/tcgplayer/3/22872/products>. The cached full response is retained in the read-only research worktree under `.scratch/eevee-research/upstream/products-20261104T015948.json`.

Full-response SHA-256: `a5c5a62d3a001a15a9a8de6567fcfca97fd9f69e143b93b5a32a516bd7d19d58`. The operator scripts pin the reviewed variant TCGplayer IDs separately from quotes and enrichment that preserves the descriptor, exact correspondence and reviewed matching inputs. A `thirdParty.cardmarket` change can break legacy descriptor correspondence and requires renewed review; it is not covered by the harmless-enrichment allowance.

477182 is Fuecoco - 002. Regular Charmander - 044 is 512035; Pokemon Center Exclusive is 512036. Product `modifiedOn` values are metadata timestamps, not quote timestamps. No current USD quote was verified. The test card is a synthetic minimal record built from the reported TCGdex IDs and descriptors; this fixture does not claim to contain the full upstream card response.

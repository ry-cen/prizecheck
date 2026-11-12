# Riftbound migration track

`scripts/migrate_riftbound.py` applies the core track followed by this Riftbound-specific track. This track is initially empty and contains no SQL migrations.

Catalog tables await owner decisions RB-PE-01 (permitted source values and source-identifier rules for `catalog_printing`), RB-PE-02 (how `basic_energy` is represented), and the generation-promotion rules. This bootstrap does not complete the Riftbound schema or enable ingestion.

Nothing here applies to a live database.

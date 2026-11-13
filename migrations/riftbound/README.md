# Riftbound catalog track

The Riftbound entry applies core first, then these four files: shared catalog
structure, sixteen restored core references, thirteen verified set codes, and
Riftbound snapshot/evidence state. Nothing here applies to a live database.

The catalog definitions come from PostgreSQL introspection of the Pokémon history.
The parity test compares all shared objects, including view columns, against that
history. Pokémon merge columns and game-specific triggers are excluded.

Riftbound uses `source='tcgcsv'` and the decimal TCGCSV product id as `source_id`;
manual rows have no source id. `basic_energy` defaults to `not_applicable` to keep
the shared column without asserting a Pokémon fact. Reviews use Riftbound's
thirteen reasons. Art views retain their shared shape but return no art, pending
image decisions. Set codes have no marketplace-id fallback in collector output.

The planner, writer, sync job and quality verdict computation are separate work.

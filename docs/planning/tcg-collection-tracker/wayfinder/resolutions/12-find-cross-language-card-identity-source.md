# Resolution — Find an authoritative cross-language Card Identity source

The research in [Cross-language Card Identity sources for Pokémon TCG](../research/cross-language-card-identity-source.md) was reviewed and accepted.

## Findings

- No inspected official Pokémon source provides a documented, reusable English↔Japanese card-name identity covering Pokémon, Trainers, and Energy.
- Available unofficial translation APIs provide incomplete candidate mappings and begin around $29 per month, exceeding the MVP's total idle-cost target before application hosting.
- Community datasets can support future review but are neither authoritative nor complete enough to define Card Identity automatically.
- Official rules confirm that Card Identity is based on rules-relevant printed name: cards with the same name count together despite different artwork or mechanics, while name modifiers and suffixes may distinguish identities.

## Decision

The MVP supports English catalog records, inventory, and deck checking only. Japanese and cross-language Card Identity mapping are deferred. TCGdex remains the free source for English Card Printings, and Card Identity groups English Printings by rules-relevant English name.

The domain hierarchy remains Card Identity → Card Printing → Card Edition so additional languages can be introduced later without changing Holding identity.

"""The social network (docs/planning/social-network/spec.md, ADR 0014).

Handles, Display Names and Invite Links, Friends and Blocks, Hidden Locations, Loans and the inbox live in this
package. Inventory code imports only its narrow functions: ``counts`` (copies reserved for, lent through and borrowed
through Loans) and ``hidden_locations`` (which Locations Friends can't see). This file imports nothing, so importing
one module of the package never loads the others.
"""

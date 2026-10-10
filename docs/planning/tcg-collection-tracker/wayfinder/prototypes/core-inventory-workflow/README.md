# Core inventory workflow — throwaway prototype

This no-persistence prototype asks: **what lightweight workflow makes nested Locations, direct versus descendant quantities, aggregate Collection totals, Decks as physical leaf Locations, and atomic transfers understandable?**

It is intentionally not production code. All state lives in browser memory and resets on refresh.

## Run it

From this directory:

```sh
python3 -m http.server 4173
```

Then open:

- `http://localhost:4173/?variant=A` — **Location explorer**: storage hierarchy is primary; direct, descendant, and subtree totals sit together.
- `http://localhost:4173/?variant=B` — **Collection ledger**: Card Editions and aggregate ownership are primary; physical distribution is revealed per card.
- `http://localhost:4173/?variant=C` — **Transfer workstation**: source and destination Locations are side-by-side around an explicit atomic operation.
- `http://localhost:4173/?variant=D` — **Synthesized workflow**: confirmed decisions combined into a realistic Locations/Collection app flow with contextual and bulk transfers.
- `http://localhost:4173/?variant=E` — **File browser + thumbnail stacks**: OS-style Location navigation with compact quantity Holdings and temporary per-copy selection handles.
- `http://localhost:4173/?variant=F` — **Selection is review**: E’s browser with destination-only Move, immediate atomic drag-drop, and one-step Undo.

Use the floating bottom switcher or the left/right arrow keys to move between variants. The URL updates without refreshing, so in-memory transfers remain visible across variants.

## Suggested walkthroughs

1. In **A**, select Display shelf, Main binder, then Gardevoir League Deck. Compare “directly here,” “in descendants,” and “Location total.” Notice that the Deck is described as a physical leaf Location.
2. In **A**, move one Pikachu from Main binder to Gardevoir League Deck. Confirm both Location counts change while the Collection total remains fixed.
3. Switch to **B**, select Pikachu, and inspect its distribution. Confirm its aggregate total is unchanged while its Binder/Deck distribution reflects the move.
4. In **B**, move a Japanese `リザードンex` between Locations and confirm localized card identity remains intact.
5. Switch to **C**, put two Locations side-by-side, select a card, and commit a transfer. Then attempt to move more copies than the source holds; confirm neither side changes.
6. Switch among all three variants without refreshing and confirm they describe the same updated inventory.

### Variant D synthesis walkthrough

1. Start in **Locations** and select Home office or Display shelf. Organizational Locations show only subtree totals and child storage Locations; they cannot hold cards.
2. Select Main binder, an ordinary storage leaf, and choose **Add child Location**. Compare the recommended “move all to new child,” alternate “create an Unsorted child,” and cancel paths. Confirming converts the parent and moves its holdings in one atomic action.
3. Select a card’s **Move copies** action. Confirm the right-side single-transfer drawer is prefilled from that Location and Card Edition and requires explicit confirmation. On a narrow viewport, confirm it becomes a full-screen surface.
4. Use the top-level **Collection** navigation. Verify every Card Edition has one aggregate total and discoverable physical distribution, then open another contextual transfer from a Collection row.
5. Open **Bulk transfer** from the in-page reorganization action (it is intentionally absent from top-level navigation). Add or remove rows, including multiple Card Editions and quantities, and commit them together.
6. Make one bulk row exceed its source holding. Confirm validation rejects the entire batch and no quantities change. Correct it, commit, and verify every affected Location plus the unchanged Collection total.

## Focused feedback questions

1. Which starting point matches how you think: **where cards are** (A), **what cards you own** (B), or **the move you are making** (C)?
2. Is “directly here / in descendants / Location total” understandable, or would different wording be clearer?
3. Does representing a Deck as a physical leaf Location feel natural once you see it alongside ordinary storage?
4. Should transfers remain a persistent side panel/workstation, or start contextually from a Location or Card Edition?
5. Is the all-or-nothing transfer guarantee visible enough before committing a move?
6. Which pieces would you combine—for example, B’s Collection index with C’s transfer workspace?

### Synthesis feedback

1. Does separating organizational Locations from storage leaves remove the direct-versus-descendant ambiguity, or introduce a new surprise?
2. When converting a stocked leaf, are the “move all to new child” and “Unsorted child” consequences clear enough to choose confidently?
3. Is a contextual drawer the right weight for one move, and is the dedicated workspace justified for bulk moves?
4. Can you find Collection from Locations and vice versa without mistaking transfer for a permanent destination?
5. Does the bulk review communicate “all rows or no rows” strongly enough before confirmation?
6. Is Variant D ready to become the interaction contract, or should any specific affordance from A, B, or C replace part of it?

### Variant E binding-model walkthrough

1. Open **E** and use the left Location tree. Organizational nodes render child folders; Main binder, Trade box, Travel case, and the Deck render dense card-thumbnail grids.
2. Inspect every collapsed stack, including low-quantity Holdings. Hover it or reach it with Tab to reveal the full card name, printing, language, variant, quantity, and Location.
3. Check a collapsed stack to select the entire quantity, then choose **Fan out** and select arbitrary temporary copy handles. These handles represent fungible copies only; refresh confirms no copy identities are persisted.
4. Combine selections across Card Editions or use **Select all**. Confirm the contextual bar continuously reports selected copies and editions.
5. Move one selected copy to open the simple confirmation. Select several copies/editions to open the prefilled Bulk transfer review, which remains all-or-nothing.
6. On desktop, drag a selected thumbnail onto another storage leaf in the tree. Confirm dropping only opens the same confirmation/review and does not mutate inventory immediately. Repeat the complete flow without drag using the Move action.
7. Verify that Collection navigation, guided stocked-leaf conversion, unrestricted Bulk transfer, organizational/storage separation, and Deck leaf rules still match D.

### Binding-model feedback

1. Does a collapsed thumbnail stack communicate “one Holding with quantity” while still feeling card-centric?
2. Is Fan out clearly a temporary selection mode rather than persistent identities for individual copies?
3. Are card details discoverable enough on hover and keyboard focus without making the grid less dense?
4. Does selecting whole stacks, individual temporary handles, and all Holdings cover realistic move workflows?
5. Does drag feel like a useful desktop shortcut while the explicit Move action remains obvious for keyboard and mobile users?
6. Should the final interaction contract use E’s file-browser binding model, or retain D’s denser row-based storage view?

### Variant F movement walkthrough

1. Select any mix of collapsed Holdings or temporary Fan out handles. Click **Move selected** and confirm that the only remaining choice is a destination storage leaf plus **Move here**—the selection itself is the card/quantity review.
2. Repeat with one copy and many copies across Card Editions; both use the identical destination-only flow.
3. On desktop, drag a selected thumbnail onto another storage leaf. Confirm the atomic move happens immediately without opening a window, then use the success toast’s **Undo** to restore every quantity.
4. For the failure behavior, make a selection stale by changing its source quantity from another variant, or target an invalid Location during state testing. Confirm no partial quantity changes occur and the affected selection remains highlighted with an explanation.

Final feedback: does destination-only Move plus immediate-but-undoable drag feel faster without sacrificing confidence, and is retaining the failed selection enough guidance to recover from stale quantities?

# Resolution — Rollout and verification

**Owner confirmed:** 2026-10-12

**Ticket:** [Decide rollout and verification](https://github.com/ry-cen/prizecheck/issues/141)

## Decision

### The redesign is a launch gate

PrizeCheck opens to anyone besides the owner only once every page is in the new shell. Production isn't launched yet: the [launch checklist](../../../tcg-collection-tracker/launch-checklist.md) authorizes no production provisioning.

- Pages move into the shell **one at a time on `dev`**. In-between states, such as an old page inside the new shell, are acceptable because only the owner sees them.
- Nothing is held on a long-lived branch. `main` is updated from `dev` whenever the owner authorizes a release, as usual. No such release is the public launch.

### Build order

The stages run in this order. Within a stage, the data steps land before the page that uses them. A data step needs no UI, so it can run alongside an earlier UI stage.

1. **Foundations.**
   - Tailwind v4 on our tokens and the component kit in `web/src/ui/` ([Decide the shared component kit](https://github.com/ry-cen/prizecheck/issues/137)).
   - The shell ([Prototype the app shell and navigation](https://github.com/ry-cen/prizecheck/issues/122)):
     - top tabs, the bottom tab bar, the avatar menu and the More sheet;
     - pages that keep their state;
     - client-side routing, with `/workspace` and `/locations` redirecting to `/collection`.

     Existing pages are mounted inside the shell unchanged for now.
   - On the kit: the sign-in screen, loading, and the unavailable and not-found states ([Prototype sign-in and loading screens](https://github.com/ry-cen/prizecheck/issues/140)). Sign-in behaviour is unchanged.
2. **Collection on the kit.**
   - The rename, and the rewrite off the `ws-` CSS.
   - The Variant Descriptor on every Card Edition, and the per-Leaf breakdown in the inspector.
   - The old Collection page is retired ([Audit the old Collection page against Collection](https://github.com/ry-cen/prizecheck/issues/123)).
3. **Owner controls and Missing cards** ([Prototype Missing cards and Owner controls](https://github.com/ry-cen/prizecheck/issues/139)), including the new card attributes and Reprint Groups queues. They must land before Catalog, because Trainer Type has to be correctable before the type chips depend on it.
4. **Catalog with Add mode** ([Prototype Catalog search in the shell](https://github.com/ry-cen/prizecheck/issues/126)).
   - **Data first:**
     - Trainer Type and evolves-from derived and backfilled;
     - the stored Format Standing table and its rebuild jobs;
     - the signed-in browse route;
     - the `add` Undo kind, readable by the existing Undo list and toast.
   - **Ships together:** Catalog, the Add cards gallery over Collection (which replaces `AddCardsDialog` and `AddCardsForm`), and Collection's category and type filters moving onto the reviewed attributes.
5. **Decks with the builder** ([Prototype the Deck experience](https://github.com/ry-cen/prizecheck/issues/125)).
   - **Data first:**
     - display data on Deck List lines;
     - the batch Deck List change command;
     - the Pick List's single multi-source Undo record;
     - the Target Format migration, its Deck List command and the publish gate.
   - Collection's Deck heading links to the builder.
6. **Published Deck and Discover** ([Decide the Published Deck and Discover pages](https://github.com/ry-cen/prizecheck/issues/127)).
   - **Data first:** the legal-only Discover listing with its format filter and summary fields.
7. **Last.**
   - Delete `style.css` once no page uses it.
   - Turn on the dark first paint in `web/index.html`. It goes last because a page still on the light UI would paint dark and then turn light.

**OAuth sign-in** ([Spec: OAuth sign-in with Google and Discord](https://github.com/ry-cen/prizecheck/issues/147)) isn't blocked by this order. Its sign-in buttons, failure messages and Sign-ins page are built in the new look as soon as stage 1 lands. If an OAuth ticket lands first, it builds on today's sign-in page and stage 1 restyles it.

### Verification

Every page and every stage follows `docs/agents/verification.md`: narrow loops while iterating, and the full gate once at each ticket's acceptance, with its counts quoted as evidence. Each page's browser tests also cover:

- **two widths,** 1280×800 and 375×812;
- **axe checks against WCAG 2.2 AA,** on the page's main states, with its dialogs and sheets open as well as closed;
- **layout assertions:** no page-level horizontal scroll, and every target on a phone at least 44 px tall or with a 44 px tap area;
- **page state:** switching tabs and back keeps the page's state, with no placeholder flash or size change ([Workspace flashes gray placeholder tiles and jumps in size on every Location switch](https://github.com/ry-cen/prizecheck/issues/121));
- **redirects:** `/workspace` and `/locations` land on `/collection`;
- **updated specs:** existing specs move to the new selectors when their page changes, rather than being deleted.

### Owner walkthroughs

- Each page gets a short checklist of 5–10 steps in the launch checklist, for the owner to run on a phone and a desktop.
- A page's code merges to `dev` on the automated checks.
- The launch needs every walkthrough ticked.

### Handoff

- **One spec** for the whole redesign, at `docs/planning/app-redesign/spec.md`, from the owner's `/to-spec`.
- The seven stages become its ticket groups and the order of blocking.
- With this ticket closed, the map has no open tickets and nothing in Not yet specified.

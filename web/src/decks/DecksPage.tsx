import { useId } from "react";
import { ArrowRight } from "lucide-react";
import { PageHeader } from "../shell/PageHeader";
import { Icon } from "../ui/Icon";
import { Segmented, segmentId } from "../ui/Segmented";
import { DecksIndexPage } from "./DecksIndexPage";
import { WantListView } from "./WantListView";
import { wantListPath, type DecksView } from "./wantListModel";

type Props = {
  /** My Decks (/decks) or the Want List (/decks/want-list). */
  view: DecksView;
  active: boolean;
  /** Opens a Deck in the deck builder (/decks/<id>). */
  onOpenDeck: (id: string) => void;
  /** Goes to another address in the app. */
  onNavigate: (to: string, options?: { replace?: boolean }) => void;
  /** The app's last service message. */
  message: string;
};

const LINK =
  "inline-flex h-control items-center gap-1 rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone";

/**
 * The Decks page (/decks and /decks/want-list): the page header and a **My Decks / Want List** switch over the two
 * views (decklist import #209, spec "The Want List page"). The phone tab bar doesn't change. The switch stays mounted
 * across both addresses, so it keeps the focus when a view is chosen; choosing the Want List always opens All Decks,
 * and the Deck page's "Want List" button opens it scoped to that Deck.
 */
export function DecksPage({
  active,
  view,
  onOpenDeck,
  onNavigate,
  message,
}: Props) {
  const idBase = useId();
  const panelId = `${idBase}-panel`;
  return (
    <main className="mx-auto box-border flex w-full min-w-0 max-w-[1536px] flex-col gap-6 px-7 py-7 phone:px-4 phone:py-5">
      {/* The switch sits right under the title, closer than the page's sections are to each other. */}
      <div className="flex min-w-0 flex-col gap-2 border-b border-border pb-2 [&>div:first-child]:mb-0 phone:[&>div:first-child>div]:ml-auto phone:[&>div:first-child>div]:basis-auto">
        <PageHeader
          title="Decks"
          actions={
            <a
              href="/discover"
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                onNavigate("/discover");
              }}
              className={LINK}
            >
              Discover decks
              <Icon icon={ArrowRight} />
            </a>
          }
        />
        <Segmented
          label="Decks view"
          idBase={idBase}
          panelId={panelId}
          value={view}
          onChange={(next) =>
            onNavigate(next === "want-list" ? wantListPath() : "/decks")
          }
          options={[
            { value: "decks", label: "My Decks" },
            { value: "want-list", label: "Want List" },
          ]}
        />
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={segmentId(idBase, view)}
        className="flex min-w-0 flex-col gap-6"
      >
        {view === "want-list" ? (
          <WantListView onOpenDeck={onOpenDeck} onNavigate={onNavigate} />
        ) : (
          <DecksIndexPage
            active={active}
            onOpenDeck={onOpenDeck}
            onNavigate={onNavigate}
          />
        )}
      </div>
      <p role="alert" className="m-0 text-body text-danger">
        {message}
      </p>
    </main>
  );
}

import { useId, useRef, useState, type ReactNode } from "react";
import { lineEdition } from "../loans/loanText";
import { useArtRetry } from "../ui/artRetry";
import { CardArt, CardPopup } from "../ui/CardPopup";

type TermsCard = {
  edition_id: string;
  name: string;
  set_code: string;
  set_name: string;
  collector_number: string;
  descriptor: Record<string, unknown>;
  image_url: string | null;
};

/** The same compact card identity in editable proposals and agreed terms. Full art stays one named button away. */
export function TradeTermsRow({
  card,
  quantity,
  context,
  details,
}: {
  card: TermsCard;
  quantity: ReactNode;
  context?: ReactNode;
  details?: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border p-3 last:border-b-0">
      <button
        ref={opener}
        type="button"
        aria-labelledby={`${id}-name ${id}-edition`}
        aria-describedby={`${id}-quantity${context ? ` ${id}-context` : ""}`}
        onClick={() => setOpen(true)}
        className="grid min-h-tap min-w-0 flex-1 basis-44 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-3 rounded-control border-0 bg-transparent p-0 text-left font-sans text-text focus-visible:outline-2 focus-visible:outline-accent phone:grid-cols-[3rem_minmax(0,1fr)]"
      >
        <TradeThumbnail url={card.image_url} />
        <span className="flex min-w-0 flex-col gap-1">
          <span
            id={`${id}-name`}
            className="text-body font-semibold wrap-anywhere"
          >
            {card.name}
          </span>
          <span
            id={`${id}-edition`}
            className="text-meta text-text-muted tabular-nums wrap-anywhere"
          >
            {lineEdition(card)}
          </span>
        </span>
      </button>
      <div id={`${id}-quantity`} className="flex min-w-0 flex-col gap-1">
        {quantity}
      </div>
      {context && (
        <div
          id={`${id}-context`}
          className="flex w-full min-w-0 flex-col gap-1"
        >
          {context}
        </div>
      )}
      <CardPopup
        open={open}
        onClose={() => setOpen(false)}
        title={card.name}
        position={null}
        canPrevious={false}
        canNext={false}
        onPrevious={() => {}}
        onNext={() => {}}
        cardKey={card.edition_id}
        returnFocus={opener}
        art={open ? <CardArt url={card.image_url} name={card.name} /> : null}
      >
        {open && (
          <>
            <p className="m-0 text-body wrap-anywhere">{lineEdition(card)}</p>
            <p className="m-0 text-meta text-text-muted wrap-anywhere">
              {card.set_name}
            </p>
            {details}
          </>
        )}
      </CardPopup>
    </li>
  );
}

/** A short missing-art label fits a thumbnail; the popup still offers the full artwork treatment. */
function TradeThumbnail({ url }: { url: string | null }) {
  const art = useArtRetry(url);
  return (
    <span
      aria-hidden="true"
      className="flex aspect-(--tile-aspect) w-full items-center justify-center overflow-hidden rounded-card bg-surface-raised text-center text-caption text-text-muted"
    >
      {art.waiting ? null : url && art.show ? (
        <img
          key={art.attempt}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={art.onError}
          className="block size-full object-cover"
        />
      ) : (
        "No art"
      )}
    </span>
  );
}

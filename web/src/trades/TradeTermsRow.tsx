import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
  fullWidthPhoneName = false,
}: {
  card: TermsCard;
  quantity: ReactNode;
  context?: ReactNode;
  details?: ReactNode;
  /** Keep compact Trade terms side by side while giving their names the tile width. */
  fullWidthPhoneName?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLSpanElement>(null);
  const [smallerName, setSmallerName] = useState(false);
  useEffect(() => {
    const name = nameRef.current;
    if (!fullWidthPhoneName || !name || typeof ResizeObserver === "undefined")
      return;
    const canvas = document.createElement("canvas");
    const measure = canvas.getContext("2d");
    if (!measure) return;
    let active = true;
    const update = () => {
      if (!active) return;
      const style = getComputedStyle(name);
      // Always measure at body size, so shrinking the name cannot toggle the result.
      measure.font = `${style.fontWeight} ${style.getPropertyValue("--font-size-md")} ${style.fontFamily}`;
      setSmallerName(
        card.name
          .split(/\s+/)
          .some((word) => measure.measureText(word).width > name.clientWidth)
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(name);
    void document.fonts?.ready.then(update);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [card.name, fullWidthPhoneName]);
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border p-3 last:border-b-0">
      <button
        ref={opener}
        type="button"
        aria-labelledby={`${id}-name ${id}-edition`}
        aria-describedby={`${id}-quantity${context ? ` ${id}-context` : ""}`}
        onClick={() => setOpen(true)}
        className={`grid min-h-tap min-w-0 flex-1 basis-44 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-3 rounded-control border-0 bg-transparent p-0 text-left font-sans text-text focus-visible:outline-2 focus-visible:outline-accent ${fullWidthPhoneName ? "phone:grid-cols-[2rem_minmax(0,1fr)] phone:gap-y-1" : "phone:grid-cols-[3rem_minmax(0,1fr)]"}`}
      >
        <TradeThumbnail
          url={card.image_url}
          className={fullWidthPhoneName ? "phone:order-2" : ""}
        />
        <span
          className={`flex min-w-0 flex-col gap-1 ${fullWidthPhoneName ? "phone:contents" : ""}`}
        >
          <span
            id={`${id}-name`}
            ref={nameRef}
            lang={fullWidthPhoneName ? "en" : undefined}
            className={`text-body font-semibold wrap-anywhere ${fullWidthPhoneName ? "phone:order-1 phone:col-span-2 phone:wrap-normal phone:break-normal phone:hyphens-auto" : ""} ${fullWidthPhoneName && smallerName ? "phone:text-control" : ""}`}
          >
            {card.name}
          </span>
          <span
            id={`${id}-edition`}
            className={`text-meta text-text-muted tabular-nums wrap-anywhere ${fullWidthPhoneName ? "phone:order-3" : ""}`}
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
function TradeThumbnail({
  url,
  className = "",
}: {
  url: string | null;
  className?: string;
}) {
  const art = useArtRetry(url);
  return (
    <span
      aria-hidden="true"
      className={`flex aspect-(--tile-aspect) w-full items-center justify-center overflow-hidden rounded-card bg-surface-raised text-center text-caption text-text-muted ${className}`}
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

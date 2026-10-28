import React, { type ReactNode } from "react";
import { Check, DollarSign, RefreshCw } from "lucide-react";
import { Icon } from "./Icon";
import { useArtRetry } from "./artRetry";

/** Where a copy is, from the page's point of view: here (solid; Collection's only state), owned
 * elsewhere (dashed, ↻) or not owned (ghost, $). The deck builder's Spread view uses all three. */
export type CopyState = "here" | "elsewhere" | "missing";

type Props = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "title" | "aria-label" | "aria-pressed" | "type"
> & {
  /** The accessible name. It must include the Variant Descriptor (or "Unspecified Variant"). */
  label: string;
  /** The hover title, with the same facts as the label. */
  title: string;
  /** The Printing's name: the Names line's first line, and the artwork's stand-in. */
  name: string;
  setName: string;
  /** The printed set code ("PAL"). When given, the Names line shows it in place of the set's name. */
  setCode?: string;
  collectorNumber: string;
  /** The Variant Descriptor as words (ui/variantLabel), shown after set and number on the Names line. */
  variant: string;
  imageUrl: string | null;
  /** Draw the Names line: the name, then "Set · Number · Variant", each cut with an ellipsis. */
  names: boolean;
  /** Pressed (selected): a dark gap and an accent ring around the art, and a check badge. Leave
   * undefined for a tile that isn't a toggle. */
  selected?: boolean;
  state?: CopyState;
  /** Content for the price line under the art (fixed height), or undefined for none. */
  price?: ReactNode;
  /** Id for the price line, so the tile can point aria-describedby at it. */
  priceId?: string;
  /** One line under the tile (fixed height), such as the copy's Location in All owned. */
  caption?: string | null;
  /** Positioned absolutely by the page (the gallery's layout model sets left, top and width inline).
   * Otherwise the tile is `relative` and sits in the page's own layout. */
  absolute?: boolean;
};

// The tile's height is fixed by the page's layout model (tokens.css: the art's aspect ratio and
// --tile-names-height, --tile-price-height and --tile-caption-height), so every line here has a fixed
// height and cuts its text with an ellipsis instead of wrapping. Those heights include each line's top padding
// (box-border), set here rather than left to Preflight's reset.
// A selected tile's focus ring sits outside its selection ring. The ring itself is base.css's.
// ROOT, ART and LINE are exported for EditionTile (#173), which shares the button, the art frame and the Names line.
export const ROOT =
  "group block box-border m-0 min-h-0 cursor-pointer rounded-card border-0 bg-transparent p-0 text-left [font:inherit] text-text aria-pressed:focus-visible:outline-offset-[calc(var(--tile-ring-gap)+var(--tile-ring-width)+var(--focus-offset))]";
export const ART =
  "block w-full aspect-(--tile-aspect) overflow-hidden rounded-card bg-[linear-gradient(135deg,var(--color-art-start),var(--color-art-end))] shadow-[0_var(--space-1)_var(--space-3)_var(--color-shadow)]";
const ART_SELECTED =
  "group-aria-pressed:shadow-[0_0_0_var(--tile-ring-gap)_var(--color-bg),0_0_0_calc(var(--tile-ring-gap)+var(--tile-ring-width))_var(--color-accent)]";
/** Here: solid. Owned elsewhere: a dashed outline. Not owned: a ghost. */
const ART_STATE: Record<CopyState, string> = {
  here: "",
  elsewhere:
    "outline-2 -outline-offset-2 outline-dashed outline-accent-outline",
  missing: "opacity-40",
};
export const LINE = "block truncate";
// box-content: 24 px inside its 2 px ring, 28 px in all, as the badge has always measured (Preflight sizes
// border-box since #184).
const BADGE =
  "pointer-events-none absolute top-1 box-content flex size-6 items-center justify-center rounded-round border-2 border-solid border-bg shadow-[0_1px_var(--space-1)_var(--color-shadow-strong)]";

/**
 * One copy of a Card Edition as a card tile (decide-component-kit: CopyTile). Collection's gallery and
 * the deck builder's Spread view use it; EditionTile shares its art, badges, states and Names line.
 *
 * The tile is a <button>. Pass `selected` to make it a toggle (aria-pressed). The page sizes and places
 * it and handles its events; every other prop (style, handlers, aria-describedby) goes to the button.
 */
export function CopyTile({
  label,
  title,
  name,
  setName,
  setCode,
  collectorNumber,
  variant,
  imageUrl,
  names,
  selected,
  state = "here",
  price,
  priceId,
  caption,
  absolute = false,
  className,
  ...button
}: Props) {
  return (
    <button
      {...button}
      type="button"
      className={[ROOT, absolute ? "absolute" : "relative", className]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
      title={title}
      aria-pressed={selected}
    >
      <span
        aria-hidden="true"
        className={`${ART} ${ART_SELECTED} ${ART_STATE[state]}`}
      >
        <TileArt name={name} imageUrl={imageUrl} />
      </span>
      {names && (
        <span className="box-border block h-(--tile-names-height) overflow-hidden pt-1">
          <span className={`${LINE} text-caption leading-4`}>{name}</span>
          <span
            className={`${LINE} text-micro leading-3.5 text-text-subtle tabular-nums`}
          >
            {setCode ?? setName} · {collectorNumber} · {variant}
          </span>
        </span>
      )}
      {price !== undefined && (
        <span
          id={priceId}
          className="box-border block h-(--tile-price-height) overflow-hidden pt-1 text-caption leading-3.5 tabular-nums"
        >
          {price}
        </span>
      )}
      {caption != null && (
        <span
          className={`${LINE} box-border h-(--tile-caption-height) pt-1 text-micro leading-3.5 text-text-subtle`}
        >
          {caption}
        </span>
      )}
      {state === "elsewhere" && (
        <span
          aria-hidden="true"
          className={`${BADGE} left-1 bg-surface-raised text-text`}
        >
          <Icon icon={RefreshCw} size={12} />
        </span>
      )}
      {state === "missing" && (
        <span
          aria-hidden="true"
          className={`${BADGE} left-1 bg-surface-raised text-text`}
        >
          <Icon icon={DollarSign} size={12} />
        </span>
      )}
      {selected && (
        <span
          aria-hidden="true"
          className={`${BADGE} right-1 bg-accent text-on-accent`}
        >
          <Icon icon={Check} size={14} />
        </span>
      )}
    </button>
  );
}

/**
 * A copy's artwork with its state (solid, dashed ↻ or ghost $) and no button around it, for a page that
 * draws several copies inside one control: the deck builder's Stacked pile. Decorative (aria-hidden); the
 * control around it names the copies.
 */
export function CopyArt({
  name,
  imageUrl,
  state = "here",
  className,
}: {
  name: string;
  imageUrl: string | null;
  state?: CopyState;
  /** Layout only (position, stacking). */
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={`relative block ${className ?? ""}`}>
      <span className={`${ART} ${ART_STATE[state]}`}>
        <TileArt name={name} imageUrl={imageUrl} />
      </span>
      {state === "elsewhere" && (
        <span className={`${BADGE} left-1 bg-surface-raised text-text`}>
          <Icon icon={RefreshCw} size={12} />
        </span>
      )}
      {state === "missing" && (
        <span className={`${BADGE} left-1 bg-surface-raised text-text`}>
          <Icon icon={DollarSign} size={12} />
        </span>
      )}
    </span>
  );
}

/** Card artwork, or the card's name on the artwork's gradient when there is no image or it fails. */
function TileArt({
  name,
  imageUrl,
}: {
  name: string;
  imageUrl: string | null;
}) {
  // A failed picture is asked for again after a short wait (artRetry.ts) before the name takes its place for good.
  const art = useArtRetry(imageUrl);
  // While a retry waits the tile is the plain art surface: no name, nothing that reads as a failure.
  if (art.waiting)
    return <span aria-hidden="true" className="block size-full" />;
  return imageUrl && art.show ? (
    <img
      key={art.attempt}
      src={imageUrl}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={art.onError}
      className="block size-full object-cover"
    />
  ) : (
    // The name breaks between words or at a hyphen ("Giratina-|EX"), hyphenated only when one word can't fit, and
    // a narrow tile (the deck builder's Spread) uses smaller text so short names stay whole, starting below the
    // corner badges.
    <span className="@container block size-full">
      <span className="box-border flex h-full items-center justify-center p-2 @max-[5rem]:px-1 @max-[5rem]:pt-6 @max-[5rem]:pb-1">
        <span className="max-w-full min-w-0 text-center text-caption font-semibold break-words hyphens-auto text-text-muted @max-[5rem]:text-micro">
          {name}
        </span>
      </span>
    </span>
  );
}

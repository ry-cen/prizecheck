import React, { type ReactNode } from "react";
import { largeArtUrl } from "./artRoute";
import { useArtRetry } from "./artRetry";
import { ART, LINE, ROOT } from "./CopyTile";

type Props = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "title" | "aria-label" | "type"
> & {
  /** The Printing's name: the Names line's first line. */
  name: string;
  /** The set's name, read in the label and title. */
  setName: string;
  /** The printed set code ("PAL"), or the TCGdex set ID when the set has none: the Names line shows "PAL 185". */
  setCode: string;
  collectorNumber: string;
  /** The Variant Descriptor as words (ui/variantLabel), shown after set and number and read in the label. */
  variant: string;
  imageUrl: string | null;
  /** Copies the collector owns. With none the artwork is darkened and there is no owned badge. */
  owned: number;
  /** The owned badge's text, by default "×N". The deck builder's library shows free of owned instead. */
  badge?: string;
  /** How the label and title say what is owned, by default "N owned" or "not owned". */
  ownedText?: string;
  /** A small Pill on the artwork, such as "?" for a Format Standing that is unknown, and the words the label
   * and title use for it ("Standard legality unknown"). */
  flag?: { text: string; label: string } | null;
  /** Content for the price line under the Names line (fixed height), or undefined for none. */
  price?: ReactNode;
  /** Id for the price line, so the tile can point aria-describedby at it. */
  priceId?: string;
  /** Copies queued to add (Catalog's Add mode, #175): above 0 the art is outlined, as a selected CopyTile's is, and
   * the label and title say "N to add". */
  queued?: number;
  /** Words read first in the name and title, such as "Add to You get" in the proposal builder's library. */
  action?: string;
};

// A queued tile's outline: a dark gap, then an accent ring around the art (CopyTile's selected ring). Its focus ring
// sits outside it.
const QUEUED_ART =
  "group-data-queued:shadow-[0_0_0_var(--tile-ring-gap)_var(--color-bg),0_0_0_calc(var(--tile-ring-gap)+var(--tile-ring-width))_var(--color-accent)]";
const QUEUED_FOCUS =
  "data-queued:focus-visible:outline-offset-[calc(var(--tile-ring-gap)+var(--tile-ring-width)+var(--focus-offset))]";

/**
 * One Card Edition as a card tile (decide-component-kit: EditionTile), for Catalog's gallery and the deck
 * builder's library. It shares CopyTile's button, art frame and Names line: the name, then "PAL 185 · Variant"
 * (the printed set code and number, by the owner's decision on #173, where CopyTile shows the set's name), each cut
 * with an ellipsis. An Edition the collector doesn't own has darkened artwork and no
 * owned badge; missing or broken artwork reads "Artwork unavailable".
 *
 * The tile is a <button>; its accessible name and hover title carry the name, set, number, Variant, what
 * is owned and the flag. The page sizes and places it; every other prop goes to the button.
 */
export function EditionTile({
  name,
  setName,
  setCode,
  collectorNumber,
  variant,
  imageUrl,
  owned,
  badge,
  ownedText,
  flag,
  price,
  priceId,
  queued = 0,
  action,
  className,
  ...button
}: Props) {
  const ownership = ownedText ?? (owned > 0 ? `${owned} owned` : "not owned");
  const facts = [
    ...(action ? [action] : []),
    name,
    `${setCode} ${collectorNumber}`,
    setName,
    variant,
    ownership,
    ...(flag ? [flag.label] : []),
    ...(queued > 0 ? [`${queued} to add`] : []),
  ];
  return (
    <button
      {...button}
      type="button"
      data-queued={queued > 0 ? "" : undefined}
      className={`${ROOT} ${QUEUED_FOCUS} relative w-full${className ? ` ${className}` : ""}`}
      aria-label={facts.join(", ")}
      title={facts.join(" · ")}
    >
      <span aria-hidden="true" className={`${ART} ${QUEUED_ART} relative`}>
        <EditionArt imageUrl={imageUrl} dark={owned <= 0} />
        {owned > 0 && (
          <span className="pointer-events-none absolute right-1 bottom-1 box-border flex h-5 min-w-5 items-center justify-center rounded-round border-2 border-solid border-bg bg-accent px-1 text-caption font-semibold leading-none text-on-accent tabular-nums">
            {badge ?? `×${owned}`}
          </span>
        )}
        {flag && (
          <span className="pointer-events-none absolute left-1 top-1 box-border flex h-5 min-w-5 max-w-[calc(100%-0.5rem)] items-center justify-start overflow-hidden whitespace-nowrap rounded-round border border-solid border-control-outline bg-surface-raised px-1 text-caption font-semibold leading-none text-text">
            <span className="min-w-0 truncate">{flag.text}</span>
          </span>
        )}
      </span>
      <span
        aria-hidden="true"
        className="box-border block h-(--tile-names-height) overflow-hidden pt-1"
      >
        <span className={`${LINE} text-caption leading-4`}>{name}</span>
        <span
          className={`${LINE} text-micro leading-3.5 text-text-subtle tabular-nums`}
        >
          {setCode} {collectorNumber} · {variant}
        </span>
      </span>
      {price !== undefined && (
        <span
          id={priceId}
          className="box-border block h-(--tile-price-height) overflow-hidden pt-1 text-caption leading-3.5 tabular-nums"
        >
          {price}
        </span>
      )}
    </button>
  );
}

/** The artwork, darkened when the Edition isn't owned, or "Artwork unavailable" when there is none or it fails. */
function EditionArt({
  imageUrl,
  dark,
}: {
  imageUrl: string | null;
  dark: boolean;
}) {
  // A gallery asks for dozens of images at once and one can fail for a moment: the first failure retries at once with
  // the large artwork (another address, so not a cached failure); later failures retry after a short wait, alternating
  // the small and large artwork (artRetry.ts), before giving up.
  const art = useArtRetry(imageUrl, 1);
  const src =
    art.attempt % 2 === 1 && imageUrl
      ? (largeArtUrl(imageUrl) ?? imageUrl)
      : imageUrl;
  // While a retry waits the tile is the plain art surface: no "Artwork unavailable".
  if (art.waiting)
    return <span aria-hidden="true" className="block size-full" />;
  return src && art.show ? (
    <img
      key={art.attempt}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={art.onError}
      className={`block size-full object-cover${dark ? " brightness-50" : ""}`}
    />
  ) : (
    <span className="box-border flex h-full items-center justify-center p-2 text-center text-caption text-text-muted">
      Artwork unavailable
    </span>
  );
}

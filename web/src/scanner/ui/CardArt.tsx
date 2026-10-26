/** A card's small picture. Every image in the scanner carries crossorigin="anonymous": the page is cross-origin
 * isolated, and the art's host answers with Access-Control-Allow-Origin: * (spec "Web and delivery"). */
export function CardArt({
  src,
  size = "md",
}: {
  src: string | null;
  size?: "sm" | "md";
}) {
  const box = size === "sm" ? "w-9" : "w-12";
  return src ? (
    <img
      src={src}
      alt=""
      crossOrigin="anonymous"
      loading="lazy"
      className={`${box} aspect-(--tile-aspect) shrink-0 rounded-card bg-surface-raised object-cover`}
    />
  ) : (
    <span
      aria-hidden="true"
      className={`${box} aspect-(--tile-aspect) shrink-0 rounded-card bg-linear-to-br from-art-start to-art-end`}
    />
  );
}

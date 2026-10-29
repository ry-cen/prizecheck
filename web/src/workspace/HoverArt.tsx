import { useState } from "react";
import { createPortal } from "react-dom";
import { largeArtUrl } from "../ui/artRoute";

/** Decorative art only. Keep the already-loaded tile image beneath the large image until it loads. */
export function HoverArt({ small, box }: { small: string; box: DOMRect }) {
  const [loaded, setLoaded] = useState(false);
  const large = largeArtUrl(small);
  const gap = 12;
  const right = window.innerWidth - box.right - gap;
  const left = box.left - gap;
  const width = Math.min(
    360,
    (window.innerHeight - 24) * 0.716,
    Math.max(left, right) - gap
  );
  if (width <= 0) return null;
  const height = width / 0.716;
  const x = right >= width ? box.right + gap : box.left - gap - width;
  const y = Math.max(12, Math.min(box.top, window.innerHeight - height - 12));
  return createPortal(
    <div
      data-hover-art=""
      aria-hidden="true"
      className="pointer-events-none fixed z-50 overflow-hidden rounded-card bg-surface shadow-xl phone:hidden"
      style={{ left: x, top: y, width, height }}
    >
      <img
        src={small}
        alt=""
        className="absolute inset-0 h-full w-full object-contain"
      />
      {large && (
        <img
          src={large}
          alt=""
          onLoad={() => setLoaded(true)}
          className="absolute inset-0 h-full w-full object-contain"
          style={{ opacity: loaded ? 1 : 0 }}
        />
      )}
    </div>,
    document.body
  );
}

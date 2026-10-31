export type MenuRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/** Viewport coordinates, with align/side treated as preferences. */
export function placeMenu({
  trigger,
  panel,
  boundary,
  align = "end",
  side = "below",
  margin = 8,
}: {
  trigger: MenuRect;
  panel: { width: number; height: number };
  boundary: MenuRect;
  align?: "start" | "end";
  side?: "above" | "below";
  margin?: number;
}) {
  const maxWidth = Math.max(0, boundary.right - boundary.left - margin * 2);
  const width = Math.min(panel.width, maxWidth);
  const below = Math.max(0, boundary.bottom - margin - trigger.bottom - 4);
  const above = Math.max(0, trigger.top - 4 - boundary.top - margin);
  if (
    (side === "below" ? below : above) < panel.height &&
    (side === "below" ? above > below : below > above)
  )
    side = side === "below" ? "above" : "below";
  const maxHeight = side === "below" ? below : above;
  const height = Math.min(panel.height, maxHeight);
  const aligned = (value: "start" | "end") =>
    value === "start" ? trigger.left : trigger.right - width;
  let left = aligned(align);
  if (left < boundary.left + margin || left + width > boundary.right - margin) {
    align = align === "start" ? "end" : "start";
    left = aligned(align);
  }
  left = Math.max(
    boundary.left + margin,
    Math.min(left, boundary.right - margin - width)
  );
  const top = Math.max(
    boundary.top + margin,
    Math.min(
      side === "below" ? trigger.bottom + 4 : trigger.top - 4 - height,
      boundary.bottom - margin - height
    )
  );
  return { left, top, side, align, maxHeight, maxWidth };
}

/** Fixed containing blocks can clip descendants; ordinary overflow ancestors cannot clip a viewport-fixed panel. */
export function fixedContainingBlock(style: CSSStyleDeclaration) {
  const properties = [
    "transform",
    "translate",
    "scale",
    "rotate",
    "perspective",
    "filter",
    "backdrop-filter",
  ];
  return (
    properties.some((key) => {
      const value = style.getPropertyValue(key);
      return value !== "" && value !== "none";
    }) ||
    /layout|paint|strict|content/.test(style.contain) ||
    (style.containerType !== "" && style.containerType !== "normal") ||
    style.willChange
      .split(",")
      .some((key) =>
        [...properties, "contain", "container-type"].includes(key.trim())
      )
  );
}

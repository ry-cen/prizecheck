import type { LucideIcon } from "lucide-react";

type Props = {
  /** A lucide-react icon, for example `Menu` imported as `MenuIcon`. */
  icon: LucideIcon;
  /** Width and height in px. 16 inside controls, 20 in headers and the tab bar. */
  size?: number;
  className?: string;
};

/** A decorative icon from lucide-react (ADR 0012). It is always hidden from assistive technology: the
 * control around it carries the name. It replaces the text glyphs (☰ ⋯ ✓ ✕ …), which render differently
 * from device to device. */
export function Icon({ icon: Glyph, size = 16, className }: Props) {
  return (
    <Glyph
      size={size}
      aria-hidden="true"
      focusable="false"
      className={className}
    />
  );
}

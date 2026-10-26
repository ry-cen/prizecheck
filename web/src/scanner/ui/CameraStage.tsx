import { Volume2, VolumeX, X } from "lucide-react";
import { type ReactNode, type RefObject } from "react";
import { Button } from "../../ui/Button";
import { CLOSE_SCANNER, LOCK_SOUND, SHUTTER } from "./copy";
import type { Box } from "./useGuideBox";

/** Close, the sound toggle and a name for the screen. Close is a full navigation, made by the caller. */
export function TopBar({
  sound,
  onSound,
  onClose,
}: {
  sound: boolean;
  onSound: () => void;
  onClose: () => void;
}) {
  return (
    <header className="flex shrink-0 items-center justify-between gap-2 px-2 py-1">
      <Button
        variant="quiet"
        icon={X}
        label={CLOSE_SCANNER}
        onClick={onClose}
      />
      <h1 className="sr-only">Scan cards</h1>
      <Button
        variant="quiet"
        icon={sound ? Volume2 : VolumeX}
        label={LOCK_SOUND}
        aria-pressed={sound}
        onClick={onSound}
      />
    </header>
  );
}

/**
 * The camera area: the live video, the guide (no standing note on it) and the hint pill, which is a live region that
 * stays in the page so each new hint is announced. `children` are the getting-ready and cannot-start views.
 */
export function CameraStage({
  stageRef,
  videoRef,
  guide,
  flash,
  hint,
  children,
}: {
  stageRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  guide: Box | null;
  /** True for a moment after a lock: the guide flashes. */
  flash: boolean;
  hint: string | null;
  children?: ReactNode;
}) {
  return (
    <div ref={stageRef} className="relative min-h-0 grow overflow-hidden bg-bg">
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        aria-hidden="true"
        className="absolute inset-0 size-full bg-bg object-contain"
      />
      {guide && (
        <div
          aria-hidden="true"
          data-testid="scanner-guide"
          data-flash={flash || undefined}
          style={guide}
          className="pointer-events-none absolute box-border rounded-panel border-2 border-text/70 transition-[background-color,border-color] duration-(--motion-duration) data-flash:border-accent data-flash:bg-accent-wash"
        />
      )}
      <div
        role="status"
        aria-label="Scanner hint"
        className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center px-4"
      >
        {hint && (
          <p className="m-0 max-w-full rounded-round border border-border-strong bg-surface-raised px-4 py-2 text-control text-text">
            {hint}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

/** Disabled while a Scan Suggestion shows: the suggestion is the choice, and the shutter is greyed out and announced as
 * unavailable. */
export function Shutter({
  onPress,
  disabled = false,
  buttonRef,
}: {
  onPress: () => void;
  disabled?: boolean;
  buttonRef?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="flex h-20 shrink-0 items-center justify-center">
      <button
        type="button"
        ref={buttonRef}
        aria-label={SHUTTER}
        disabled={disabled}
        onClick={onPress}
        className="m-0 box-border size-16 cursor-pointer rounded-round border-4 border-text bg-accent p-0 enabled:hover:bg-accent-strong disabled:cursor-default disabled:opacity-45"
      />
    </div>
  );
}

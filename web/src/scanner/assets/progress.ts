// Plain byte progress for the first download. Bytes only: no names, hashes or versions (AGENTS.md UI copy, D14).
export type ScannerProgress = { loaded: number; total: number };

export type ProgressMeter = {
  /** Count decoded body bytes as they arrive. */
  add(bytes: number): void;
  /** Re-plan the remaining work (after a manifest re-read); what is already counted stays counted. */
  replan(remaining: number): void;
  /** Report the current state once, even when nothing has changed. */
  emit(): void;
};

export function createProgress(
  remaining: number,
  onProgress?: (p: ScannerProgress) => void
): ProgressMeter {
  let loaded = 0;
  let total = remaining;
  const emit = () => onProgress?.({ loaded: Math.min(loaded, total), total });
  return {
    add(bytes) {
      loaded += bytes;
      emit();
    },
    replan(rest) {
      total = loaded + rest;
      emit();
    },
    emit,
  };
}

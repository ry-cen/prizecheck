// Why the scanner cannot start, as far as a collector can act on it. Only a missing camera, a denied camera and an
// unsupported browser are named; every other failure is "generic" and the screen never says why (spec "Cannot start").
export type StartCause = "no-camera" | "denied" | "unsupported" | "generic";

/** A getUserMedia failure (or any error thrown while the camera starts). */
export function cameraCause(error: unknown): StartCause {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "no-camera";
  return "generic";
}

/** What `loadScannerAssets` reports. */
export function loadCause(failed: "unsupported" | "cannot-start"): StartCause {
  return failed === "unsupported" ? "unsupported" : "generic";
}

/** ORT wasm threads (spec, "Runtime"): up to 4 when the worker is cross-origin isolated, else 1. No message field carries it. */
export function threadCount(): number {
  return self.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency ?? 1)
    : 1;
}

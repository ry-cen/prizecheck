// Main-thread capability check (resolution D1). No harness imports.
const SIMD = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8,
  0, 65, 0, 253, 15, 253, 98, 11,
]);

export type Caps = { ok: boolean; missing: string[]; simd: boolean };

/** `threads` > 1 additionally requires cross-origin isolation (ORT silently drops to one thread without it). */
export function checkCaps(threads = 1): Caps {
  const missing: string[] = [];
  let simd = false;
  try {
    simd = WebAssembly.validate(SIMD);
  } catch {
    simd = false;
  }
  if (!simd) missing.push("wasm-simd");
  if (typeof Worker !== "function") missing.push("Worker");
  if (typeof OffscreenCanvas === "undefined") missing.push("OffscreenCanvas");
  if (typeof createImageBitmap !== "function")
    missing.push("createImageBitmap");
  if (!(
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  ))
    missing.push("getUserMedia");
  if (!(typeof crypto !== "undefined" && crypto.subtle))
    missing.push("crypto.subtle");
  if (typeof caches === "undefined") missing.push("caches");
  if (!("locks" in navigator)) missing.push("navigator.locks");
  if (typeof DecompressionStream !== "function")
    missing.push("DecompressionStream");
  if (threads > 1 && !self.crossOriginIsolated)
    missing.push("crossOriginIsolated");
  return { ok: missing.length === 0, missing, simd };
}

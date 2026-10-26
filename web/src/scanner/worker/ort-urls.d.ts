// Vite `?url` imports of the runtime's own files (used only by ort.ts).
declare module "onnxruntime-web/ort-wasm-simd-threaded.mjs?url" {
  const url: string;
  export default url;
}
declare module "onnxruntime-web/ort-wasm-simd-threaded.wasm?url" {
  const url: string;
  export default url;
}

// The only module in src/scanner that imports the ONNX runtime (worker graph only; the bundle-boundary guardrail checks it).
import * as ort from "onnxruntime-web/wasm";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";

/** Call before any session is created. The runtime files are same-origin hashed assets, so ORT never falls back to a CDN. */
export function configureOrt(numThreads: number): void {
  ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
  ort.env.wasm.numThreads = numThreads;
  ort.env.wasm.proxy = false;
}

export { ort };

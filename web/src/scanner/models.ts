// Generated from web/scanner-models.lock.json by scripts/fetch-scanner-models.mjs --write; `npm run check` fails when
// the two disagree. A model change is a new lock file, a new id and a regenerated file.
export const SCANNER_MODEL_ID = "dinov2s-int8-c179f8f7-p1";

export type ScannerModelRole = "embedder" | "ocr-recognizer" | "ocr-dictionary";

export type ScannerModelFile = {
  role: ScannerModelRole;
  name: string;
  /** Where nginx serves the file: content-addressed and immutable. */
  path: string;
  bytes: number;
  sha256: string;
};

export const SCANNER_MODEL_FILES: readonly ScannerModelFile[] = [
  {
    role: "embedder",
    name: "dinov2-small-model_quantized.onnx",
    path: "/scanner/m/c179f8f7f592449c/dinov2-small-model_quantized.onnx",
    bytes: 24446700,
    sha256: "c179f8f7f592449c4c1bca4cd124a7538021428c5ffb89afde9503935b197efb",
  },
  {
    role: "ocr-recognizer",
    name: "paddleocr-english-rec.onnx",
    path: "/scanner/m/4e16deb22c4da646/paddleocr-english-rec.onnx",
    bytes: 7830888,
    sha256: "4e16deb22c4da6468bdca539b2cd3c8687825538b67109177c47d359ab994cd7",
  },
  {
    role: "ocr-dictionary",
    name: "paddleocr-english-dict.txt",
    path: "/scanner/m/e025a66d31f327ba/paddleocr-english-dict.txt",
    bytes: 1416,
    sha256: "e025a66d31f327ba0c232e03f407ae8d105e1e709e7ccb3f408aa778c24e70d6",
  },
];

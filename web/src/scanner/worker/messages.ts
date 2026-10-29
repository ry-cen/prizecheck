// Main thread <-> recognizer worker (resolution "Worker message contract" with the spec's amendments).
// Frames: the main thread crops each camera frame to the guide rectangle expanded by 25% of the guide's width and
// height on every side (clipped to the frame), at native resolution, and transfers it as an ImageBitmap. `guide` is
// the guide rectangle in that bitmap's pixels [x0, y0, x1, y1]. At most one frame is in flight; the main thread drops
// frames while the worker is busy. No message ever carries a frame or image data from the worker to the main thread.

/** Cache Storage name that holds the scanner's verified blobs. */
export const SCANNER_CACHE = "prizecheck-scanner";

export type ScannerAssets = {
  embedder: string; // Cache Storage key: /scanner/m/<sha16>/dinov2-small-model_quantized.onnx
  ocr: string; // Cache Storage key: /scanner/m/<sha16>/paddleocr-english-rec.onnx
  dict: string; // Cache Storage key: /scanner/m/<sha16>/paddleocr-english-dict.txt
  cards: string; // Cache Storage key: /api/scanner/cards/<key>
  fingerprints: string | null; // Cache Storage key: /api/scanner/fingerprints/<sha256>; null = image matching off
};

export type LockVia = "auto" | "suggest" | "shutter";
export type GateReason = "soft" | "dark" | "bright" | "clipped";
export type OutcomeReason = "unresolved" | "offline" | "full" | "dismissed";

export type ToWorker =
  | { t: "init"; assets: ScannerAssets; debugTiming: boolean } // runtime wasm/mjs URLs and the thread count come from the worker, not here
  | {
      t: "frame";
      id: number;
      bitmap: ImageBitmap; // transferred
      guide: [number, number, number, number];
    }
  | { t: "shutter" } // does nothing while a suggestion (or any lock) is pending
  | { t: "lockOutcome"; lockId: number; added: boolean; reason?: OutcomeReason }
  | { t: "pause" } // tray sheet open or page hidden: drop frames, keep state
  | { t: "resume" }
  | { t: "swap"; cards?: string; fingerprints?: string }; // new verified assets; applied between frames

export type FromWorker =
  | { t: "ready"; imageMatching: boolean }
  | { t: "frameDone"; id: number } // the next frame may be sent
  | { t: "gate"; id: number; ok: boolean; reason?: GateReason } // plain UI hint only
  | {
      t: "lock";
      lockId: number;
      printingIds: string[]; // up to 3, best first
      via: LockVia;
      // Up to 7 Printings that look like printingIds[0] (same Reprint Group, close fingerprint), closest first, never
      // printingIds[0]; may repeat ids from printingIds; [] when none. An automatic lock keeps only those its printed number supports.
      lookalikes: string[];
    }
  | { t: "absent"; lockId: number } // once per pending lock (any via), when the card has left the guide
  | { t: "miss" } // shutter with no candidate: open search
  | { t: "timing"; id: number; ms: Record<string, number> } // only when init.debugTiming
  | { t: "error"; code: "INIT_FAILED" | "ASSET_INVALID" };

export const STAGES = [
  "read",
  "gate",
  "corners",
  "warp",
  "ocrPrep",
  "ocrRun",
  "ocrParse",
  "embedPrep",
  "embedRun",
  "search",
  "combine",
  "vote",
  "total",
] as const;
export type Stage = (typeof STAGES)[number];

export type VoteState = "armed" | "pending" | "locked" | "cooldown";

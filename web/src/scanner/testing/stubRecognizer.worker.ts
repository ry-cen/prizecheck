// Worker entry of the stub recognizer. The page passes the script as the worker's `name`:
//   new Worker(new URL("./stubRecognizer.worker.ts", import.meta.url), { type: "module", name: JSON.stringify(script) })
import { StubRecognizer, canvasReader } from "./stubRecognizer";
import type { StubScript } from "./stubRecognizer";
import type { FromWorker, ToWorker } from "../worker/messages";

const script = JSON.parse(self.name || '{"frames":[]}') as StubScript;
const stub = new StubRecognizer(
  script,
  (m: FromWorker) => (self as unknown as Worker).postMessage(m),
  canvasReader()
);
self.onmessage = (ev: MessageEvent<ToWorker>): void => {
  // Test seam, outside the worker contract: the page asks whether this worker is cross-origin isolated.
  if ((ev.data as { t: string }).t === "test:isolated?") {
    (self as unknown as Worker).postMessage({
      t: "test:isolated",
      value: self.crossOriginIsolated,
    });
    return;
  }
  stub.handle(ev.data);
};

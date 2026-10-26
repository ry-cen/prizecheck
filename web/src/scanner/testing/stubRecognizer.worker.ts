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
self.onmessage = (ev: MessageEvent<ToWorker>): void => stub.handle(ev.data);

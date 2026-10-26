// Embedder and recogniser sessions behind a structural runtime type, so this file never imports the runtime itself.

export type TensorLike = {
  readonly dims: readonly number[];
  readonly data: unknown;
  dispose(): void;
};
export type SessionLike = {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, TensorLike>): Promise<Record<string, TensorLike>>;
};
export type OrtLike = {
  InferenceSession: {
    create(bytes: Uint8Array, opts: object): Promise<SessionLike>;
  };
  Tensor: new (
    type: "float32",
    data: Float32Array,
    dims: number[]
  ) => TensorLike;
};

export type Models = {
  embed(x: Float32Array): Promise<Float32Array>;
  ocr(
    x: Float32Array,
    width: number
  ): Promise<{ data: Float32Array; T: number; C: number }>;
  initMs: { embedCreate: number; ocrCreate: number };
};

const SESSION_OPTS = {
  executionProviders: ["wasm"],
  graphOptimizationLevel: "all",
};
const DIM = 384;

export async function createModels(
  ort: OrtLike,
  embedBytes: Uint8Array,
  ocrBytes: Uint8Array,
  classes: readonly string[]
): Promise<Models> {
  let t = performance.now();
  const embedSession = await ort.InferenceSession.create(
    embedBytes,
    SESSION_OPTS
  );
  const embedCreate = performance.now() - t;
  t = performance.now();
  const ocrSession = await ort.InferenceSession.create(ocrBytes, SESSION_OPTS);
  const ocrCreate = performance.now() - t;

  const disposeAll = (outs: Record<string, TensorLike>): void => {
    for (const k of Object.keys(outs)) outs[k].dispose();
  };

  return {
    initMs: { embedCreate, ocrCreate },
    async embed(x) {
      const feeds = {
        [embedSession.inputNames[0]]: new ort.Tensor(
          "float32",
          x,
          [1, 3, 224, 224]
        ),
      };
      const outs = await embedSession.run(feeds);
      try {
        const o = outs["last_hidden_state"];
        if (!o) throw new Error("embedder has no last_hidden_state output");
        const dims = o.dims;
        if (dims.length !== 3 || dims[2] !== DIM)
          throw new Error(`embedder output dims [${dims.join(",")}]`);
        return (o.data as Float32Array).slice(0, DIM); // CLS token, copied before dispose
      } finally {
        disposeAll(outs);
      }
    },
    async ocr(x, width) {
      const feeds = {
        [ocrSession.inputNames[0]]: new ort.Tensor("float32", x, [
          1,
          3,
          48,
          width,
        ]),
      };
      const outs = await ocrSession.run(feeds);
      try {
        const o = outs[ocrSession.outputNames[0]];
        if (!o) throw new Error("recogniser has no output");
        const dims = o.dims;
        if (dims.length !== 3)
          throw new Error(`recogniser output dims [${dims.join(",")}]`);
        const T = dims[1];
        const C = dims[2];
        if (C !== classes.length)
          throw new Error(
            `recogniser output ${C} classes, dict has ${classes.length}`
          );
        return { data: (o.data as Float32Array).slice(), T, C };
      } finally {
        disposeAll(outs);
      }
    },
  };
}

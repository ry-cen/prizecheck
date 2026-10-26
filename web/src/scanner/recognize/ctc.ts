// Port of scanspike/paddle_rec.py load_classes / ctc_decode.

export function loadClasses(dictText: string): string[] {
  const lines = dictText.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return ["<blank>", ...lines, " "];
}

/** logits is [T][C] row-major. Argmax per step (first maximum), collapse repeats, drop blank (0). */
export function ctcDecode(
  logits: Float32Array,
  T: number,
  C: number,
  classes: readonly string[]
): string {
  let out = "";
  let prev = -1;
  for (let t = 0; t < T; t++) {
    const o = t * C;
    let bi = 0;
    let bv = logits[o];
    for (let c = 1; c < C; c++) {
      if (logits[o + c] > bv) {
        bv = logits[o + c];
        bi = c;
      }
    }
    if (bi !== prev && bi !== 0) out += classes[bi];
    prev = bi;
  }
  return out;
}

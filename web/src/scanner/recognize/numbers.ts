// Port of scanspike/numbers.py. ASCII semantics for \d, \b and case tests (Unicode text may differ; see the brief, 3.4 pitfall 6).
import { releaseOf } from "./cardTable";
import { cmpStr } from "./types";
import type { Candidate, CardDb, NumberIndex, NumberReading } from "./types";

export type { NumberIndex, NumberReading };

const KEY_RE = /^([A-Za-z]*)([0-9]+)([a-z]?)$/;

export function numberKey(
  localId: string
): [prefix: string, n: number, suffix: string] | null {
  const m = KEY_RE.exec(localId);
  if (!m) return null;
  return [m[1].toUpperCase(), parseInt(m[2], 10), m[3]];
}

export function keyStr(p: string, n: number, s: string): string {
  return p + "|" + n + "|" + s;
}

export function buildNumberIndex(db: CardDb): NumberIndex {
  const byKey = new Map<string, string[]>();
  const printedDen = new Map<string, Map<string, number>>();
  const abbrToSets = new Map<string, string[]>();
  const cardSet = new Map<string, string>();
  const release = new Map<string, string>();
  const prefixes = new Set<string>();
  for (const s of db.sets) {
    let d = printedDen.get(s.id);
    if (!d) {
      d = new Map();
      printedDen.set(s.id, d);
    }
    if ((s.official ?? 0) > 0) d.set("", s.official as number);
    if (s.code) {
      const k = s.code.toUpperCase();
      const list = abbrToSets.get(k);
      if (list) list.push(s.id);
      else abbrToSets.set(k, [s.id]);
    }
  }
  const rows: number[] = db.ids.map((_, i) => i);
  rows.sort((a, b) => cmpStr(db.ids[a], db.ids[b]));
  for (const row of rows) {
    const id = db.ids[row];
    const setId = db.sets[db.setOfRow[row]].id;
    cardSet.set(id, setId);
    release.set(id, releaseOf(db, row));
    const key = numberKey(db.numbers[row]);
    if (key === null) continue;
    const ks = keyStr(key[0], key[1], key[2]);
    const list = byKey.get(ks);
    if (list) list.push(id);
    else byKey.set(ks, [id]);
    if (key[0]) {
      prefixes.add(key[0]);
      let d = printedDen.get(setId);
      if (!d) {
        d = new Map();
        printedDen.set(setId, d);
      }
      d.set(key[0], Math.max(d.get(key[0]) ?? 0, key[1]));
    }
  }
  const knownPrefixes = [...prefixes].sort(
    (a, b) => b.length - a.length || cmpStr(a, b)
  );
  const knownAbbrs = [...abbrToSets.keys()]
    .filter((a) => !a.includes(":"))
    .sort(cmpStr);
  const dens = new Set<number>();
  for (const d of printedDen.values()) {
    const v = d.get("");
    if (v !== undefined) dens.add(v);
  }
  const knownDens = [...dens].sort((a, b) => a - b);
  return {
    byKey,
    printedDen,
    abbrToSets,
    cardSet,
    release,
    knownPrefixes,
    knownAbbrs,
    knownDens,
  };
}

// ---------------------------------------------------------------- parsing

const DIGIT_MAP = new Map<string, string>([
  ["O", "0"],
  ["Q", "0"],
  ["D", "0"],
  ["I", "1"],
  ["L", "1"],
  ["l", "1"],
  ["|", "1"],
  ["S", "5"],
  ["B", "8"],
  ["Z", "2"],
  ["G", "6"],
]);
const LETTER_MAP = new Map<string, string>([
  ["0", "O"],
  ["1", "I"],
  ["5", "S"],
  ["8", "B"],
]);

// Python's \s also matches \x1c-\x1f.
const WS = "[\\s\\x1c-\\x1f]";
const JOINED_SET_RE = /\b([A-Z0-9]{2,4})EN(?=[OQDISBZ]{0,2}[0-9])/g;
const SET_RE = new RegExp(`\\b([A-Z0-9]{2,4})${WS}*EN\\b`);
const SLASH_RE = new RegExp(
  `(?<![A-Za-z0-9])([A-Za-z0-9]{1,24})${WS}*/${WS}*([A-Za-z0-9]{1,6})(?![0-9])`,
  "g"
);
const TRAIL_RE = /[0-9OQDISBZ]{1,3}$/;
const DIGIT_TRAIL_RE = /[0-9]{1,3}$/;
const DIGIT_RUN_RE = /[0-9]+$/;
const BARE_RE = /\b([0-9]{1,3})\b/g;
const SUB_SLASH_RE = new RegExp(
  `(?<![A-Za-z0-9])([0-9]{1,3})${WS}*[\\\\|lI]${WS}*([0-9]{2,3})(?![0-9])`,
  "g"
);
const ONE_SLASH_RE = /(?<![A-Za-z0-9])([0-9]{3})1([0-9]{3})(?![0-9])/g;
const SPACE_SLASH_RE = new RegExp(
  `(?<![A-Za-z0-9/])([0-9]{1,3})${WS}+([0-9]{2,3})(?![0-9/])`,
  "g"
);
const DANGLE_RE = new RegExp(
  `(?<![A-Za-z0-9])([0-9]{1,3})${WS}*/${WS}*(?![A-Za-z0-9])`,
  "g"
);
const BLANK_RE = new RegExp(`^${WS}*$`);

function toDigits(s: string): string | null {
  let out = "";
  for (const ch of s) out += DIGIT_MAP.get(ch) ?? ch;
  return /^[0-9]+$/.test(out) && out.length >= 1 && out.length <= 3
    ? out
    : null;
}

function parseDen(token: string, prefix: string): number | null {
  if (!token.toUpperCase().startsWith(prefix)) return null;
  const d = toDigits(token.slice(prefix.length));
  return d !== null ? parseInt(d, 10) : null;
}

function resolveSetCode(
  raw: string,
  knownAbbrs: readonly string[]
): string | null {
  let mapped = "";
  for (const ch of raw) mapped += LETTER_MAP.get(ch) ?? ch;
  if (knownAbbrs.length === 0) return mapped;
  const abbrs = new Set(knownAbbrs);
  for (const cand of [raw, mapped]) {
    for (let i = 0; i < 3; i++) {
      const suf = cand.slice(i);
      if (suf.length >= 2 && abbrs.has(suf)) return suf;
    }
  }
  return null;
}

function denOrPartial(
  den: number | null,
  prefix: string,
  knownDens: readonly number[]
): [number | null, string] {
  if (
    prefix === "" &&
    den !== null &&
    knownDens.length > 0 &&
    !knownDens.includes(den)
  ) {
    const sd = String(den);
    if (
      knownDens.some(
        (k) => String(k).startsWith(sd) && String(k).length > sd.length
      )
    )
      return [null, sd];
  }
  return [den, ""];
}

function isLowerAlpha(c: string): boolean {
  return c !== c.toUpperCase() && c === c.toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseNumberText(
  text: string,
  knownPrefixes: readonly string[],
  knownAbbrs: readonly string[] = [],
  knownDens: readonly number[] = [],
  tolerant = false
): NumberReading[] {
  if (!text || BLANK_RE.test(text)) return [];
  const prefixes = [...knownPrefixes];
  text = text.replace(JOINED_SET_RE, (_m, g1: string) => `${g1} EN `);

  let setCode: string | null = null;
  const sm = SET_RE.exec(text);
  if (sm) setCode = resolveSetCode(sm[1], knownAbbrs);

  const readings: NumberReading[] = [];
  const seen = new Set<string>();

  const add = (
    prefix: string,
    number: number,
    suffix: string,
    den: number | null,
    denPrefix: string,
    raw: string,
    denPartial = ""
  ): void => {
    const key = JSON.stringify(
      tolerant
        ? [prefix, number, suffix, den, denPartial]
        : [prefix, number, suffix, den]
    );
    if (seen.has(key)) return;
    seen.add(key);
    readings.push({
      prefix,
      number,
      suffix,
      denominator: den,
      denPrefix,
      setCode,
      raw,
      denPartial,
    });
  };

  const addDen = (
    p: string,
    n: number,
    suffix: string,
    den: number | null,
    raw: string,
    denPrefix: string | null = null
  ): void => {
    let part = "";
    if (tolerant) [den, part] = denOrPartial(den, p, knownDens);
    add(
      p,
      n,
      suffix,
      den,
      denPrefix === null
        ? den !== null
          ? p
          : ""
        : den !== null
          ? denPrefix
          : "",
      raw,
      part
    );
  };

  // (b) slash pairs
  for (const m of text.matchAll(SLASH_RE)) {
    const token = m[1],
      rtoken = m[2];
    const raw = m[0];
    const found: [string, number, string][] = [];
    for (const p of [...prefixes, ""]) {
      if (!token.toUpperCase().startsWith(p)) continue;
      let rem = token.slice(p.length);
      let suffix = "";
      if (rem.length > 1) {
        const last = rem[rem.length - 1];
        if (isLowerAlpha(last) && last !== "l") {
          suffix = last;
          rem = rem.slice(0, -1);
        }
      }
      const d = toDigits(rem);
      if (d !== null) found.push([p, parseInt(d, 10), suffix]);
    }
    if (found.length > 0) {
      for (const [p, n, suffix] of found)
        addDen(p, n, suffix, parseDen(rtoken, p), raw);
    } else {
      const den = parseDen(rtoken, "");
      const run = DIGIT_RUN_RE.exec(token);
      if (den !== null && run && run[0].length >= 4) {
        for (const k of [3, 2, 1])
          addDen("", parseInt(run[0].slice(-k), 10), "", den, raw, "");
      } else if (den !== null) {
        for (const rx of [DIGIT_TRAIL_RE, TRAIL_RE]) {
          const t = rx.exec(token);
          const d = t ? toDigits(t[0]) : null;
          if (d !== null) addDen("", parseInt(d, 10), "", den, raw);
        }
      }
    }
  }

  if (tolerant && knownDens.length > 0 && readings.length === 0) {
    const kd = new Set(knownDens);
    for (const rx of [SUB_SLASH_RE, ONE_SLASH_RE, SPACE_SLASH_RE]) {
      for (const m of text.matchAll(rx)) {
        if (kd.has(parseInt(m[2], 10)))
          add("", parseInt(m[1], 10), "", parseInt(m[2], 10), "", m[0]);
      }
      if (readings.length > 0) break;
    }
  }
  if (tolerant && readings.length === 0) {
    for (const m of text.matchAll(DANGLE_RE))
      add("", parseInt(m[1], 10), "", null, "", m[0]);
  }

  // (c) promo without a slash
  const longP = prefixes.filter((p) => p.length >= 2);
  if (longP.length > 0) {
    let up = text.toUpperCase();
    if (up.length !== text.length) up = text;
    const pat = new RegExp(
      `\\b(${longP.map(escapeRe).join("|")})${WS}?([0-9OISBZ]{2,3})([A-Z]?)\\b`,
      "gd"
    );
    for (const m of up.matchAll(pat)) {
      const d = toDigits(m[2]);
      if (d === null) continue;
      const ind = m.indices as RegExpIndicesArray;
      let suffix = "";
      if (m[3] && isLowerAlpha(text[ind[3][0]])) suffix = text[ind[3][0]];
      add(
        m[1],
        parseInt(d, 10),
        suffix,
        null,
        "",
        text.slice(ind[0][0], ind[0][1])
      );
    }
  }

  // (d) bare numbers, only when a set code was seen and nothing else matched
  if (setCode !== null && readings.length === 0) {
    for (const m of text.matchAll(BARE_RE))
      add("", parseInt(m[1], 10), "", null, "", m[0]);
  }

  return readings;
}

// ----------------------------------------------------------------- lookup

export function lookup(
  readings: readonly NumberReading[],
  idx: NumberIndex
): Candidate[] {
  const best = new Map<string, number>();
  for (const r of readings) {
    for (const cid of idx.byKey.get(keyStr(r.prefix, r.number, r.suffix)) ??
      []) {
      const sid = idx.cardSet.get(cid) as string;
      const den = idx.printedDen.get(sid);
      if (r.denPartial) {
        const pd = den?.get(r.prefix);
        if (!(
          pd !== undefined &&
          String(pd).startsWith(r.denPartial) &&
          String(pd).length > r.denPartial.length
        ))
          continue;
      }
      const setOk =
        r.setCode !== null &&
        (idx.abbrToSets.get(r.setCode) ?? []).includes(sid);
      const denOk =
        r.denominator !== null && den?.get(r.prefix) === r.denominator;
      const tier = setOk ? 3 : denOk ? 2 : 1;
      if (tier > (best.get(cid) ?? 0)) best.set(cid, tier);
    }
  }
  const ids = [...best.keys()].sort(cmpStr);
  ids.sort((a, b) =>
    cmpStr(idx.release.get(b) ?? "", idx.release.get(a) ?? "")
  );
  ids.sort((a, b) => (best.get(b) as number) - (best.get(a) as number));
  return ids.map((id) => ({
    id,
    source: "ocr" as const,
    tier: best.get(id) as number,
    score: null,
  }));
}

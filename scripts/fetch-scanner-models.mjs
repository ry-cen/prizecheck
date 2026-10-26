// Fetches the card scanner's pinned models into web/public/scanner/m/<sha256[0:16]>/<name> (gitignored), which nginx
// serves under /scanner/m/ and Vite copies into dist/web. Node, because web.Dockerfile's build stage has no Python.
//
//   node scripts/fetch-scanner-models.mjs            download what is missing or wrong, verify bytes and sha256
//   node scripts/fetch-scanner-models.mjs --check    validate web/scanner-models.lock.json and that
//                                                    web/src/scanner/models.ts agrees with it (npm run check)
//   node scripts/fetch-scanner-models.mjs --write    regenerate web/src/scanner/models.ts from the lock file
//
// Options: --lock FILE, --out DIR, --models-ts FILE override the paths (tests use them).
// Environment: SCANNER_MODELS_STUB_DIR serves each URL from DIR/<name> instead of the network, for tests and CI;
// no real model is downloaded then. Downloads are limited to https://huggingface.co/ URLs (its CDN redirects are followed;
// the sha256 check is what pins the bytes).
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "huggingface.co";
/** The whole download of one file, so a stalled connection fails the image build instead of hanging it. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const ROLES = ["embedder", "ocr-recognizer", "ocr-dictionary"];

export function modelId(lock) {
  const embedder = lock.files.find((file) => file.role === "embedder");
  return `${lock.family}-${embedder.sha256.slice(0, 8)}-p${lock.preprocessing}`;
}

/** The problems with a parsed lock file (empty when it is sound). */
export function lockProblems(lock) {
  const problems = [];
  if (typeof lock?.family !== "string" || !/^[a-z0-9-]+$/.test(lock.family))
    problems.push("family must be a lowercase slug");
  if (!Number.isInteger(lock?.preprocessing) || lock.preprocessing < 1)
    problems.push("preprocessing must be a positive integer");
  if (!Array.isArray(lock?.files)) return [...problems, "files must be a list"];
  const names = new Set();
  for (const file of lock.files)
    if (!ROLES.includes(file?.role))
      problems.push(`${file?.name ?? "(unnamed)"}: unknown role ${file?.role}`);
  for (const role of ROLES) {
    if (lock.files.filter((file) => file.role === role).length !== 1)
      problems.push(`exactly one file must have role ${role}`);
  }
  for (const file of lock.files) {
    const label = file?.name ?? "(unnamed)";
    if (
      !/^[A-Za-z0-9._-]+$/.test(file?.name ?? "") ||
      file.name.startsWith(".")
    )
      problems.push(`${label}: name must be a plain file name`);
    if (names.has(file?.name)) problems.push(`${label}: duplicate name`);
    names.add(file?.name);
    let url = null;
    try {
      url = new URL(file.url);
    } catch {
      /* reported below */
    }
    if (!url || url.protocol !== "https:" || url.hostname !== HOST)
      problems.push(`${label}: url must be an https://${HOST}/ address`);
    else if (!/\/resolve\/[0-9a-f]{40}\//.test(url.pathname))
      problems.push(`${label}: url must pin a 40-character revision`);
    if (!Number.isInteger(file.bytes) || file.bytes <= 0)
      problems.push(`${label}: bytes must be a positive integer`);
    if (!/^[0-9a-f]{64}$/.test(file.sha256 ?? ""))
      problems.push(`${label}: sha256 must be 64 lowercase hex characters`);
  }
  return problems;
}

export function modelsSource(lock) {
  const files = lock.files
    .map((file) => {
      const modelPath = `/scanner/m/${file.sha256.slice(0, 16)}/${file.name}`;
      return `  {\n    role: ${JSON.stringify(file.role)},\n    name: ${JSON.stringify(file.name)},\n    path: ${JSON.stringify(modelPath)},\n    bytes: ${file.bytes},\n    sha256: ${JSON.stringify(file.sha256)},\n  },`;
    })
    .join("\n");
  return `// Generated from web/scanner-models.lock.json by scripts/fetch-scanner-models.mjs --write; \`npm run check\` fails when
// the two disagree. A model change is a new lock file, a new id and a regenerated file.
export const SCANNER_MODEL_ID = ${JSON.stringify(modelId(lock))};

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
${files}
];
`;
}

async function readLock(file) {
  const lock = JSON.parse(await readFile(file, "utf8"));
  const problems = lockProblems(lock);
  if (problems.length) throw new Error(`${file}: ${problems.join("; ")}`);
  return lock;
}

async function sha256Of(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function verified(file, entry) {
  if (!existsSync(file) || (await stat(file)).size !== entry.bytes)
    return false;
  return (await sha256Of(file)) === entry.sha256;
}

async function openBody(entry, stubDir) {
  if (stubDir)
    return Readable.from(createReadStream(path.join(stubDir, entry.name)));
  const response = await fetch(entry.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body)
    throw new Error(
      `${entry.name}: download failed with HTTP ${response.status}`
    );
  return Readable.fromWeb(response.body);
}

async function download(entry, directory, stubDir) {
  const target = path.join(directory, entry.sha256.slice(0, 16), entry.name);
  if (await verified(target, entry)) return "present";
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const body = await openBody(entry, stubDir);
    body.on("data", (chunk) => {
      bytes += chunk.length;
      // Stop at the first byte past the pinned length rather than spooling an oversized body.
      if (bytes > entry.bytes) {
        body.destroy(
          new Error(
            `${entry.name}: more than the expected ${entry.bytes} bytes`
          )
        );
        return;
      }
      hash.update(chunk);
    });
    await pipeline(body, createWriteStream(partial));
    if (bytes !== entry.bytes)
      throw new Error(
        `${entry.name}: expected ${entry.bytes} bytes, got ${bytes}`
      );
    if (hash.digest("hex") !== entry.sha256)
      throw new Error(`${entry.name}: sha256 does not match the lock file`);
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return "fetched";
}

export async function main(argv) {
  const options = {
    lock: path.join(ROOT, "web/scanner-models.lock.json"),
    out: path.join(ROOT, "web/public/scanner/m"),
    modelsTs: path.join(ROOT, "web/src/scanner/models.ts"),
  };
  let mode = "fetch";
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--check" || arg === "--write") mode = arg.slice(2);
    else if (arg === "--lock") options.lock = path.resolve(argv[++index]);
    else if (arg === "--out") options.out = path.resolve(argv[++index]);
    else if (arg === "--models-ts")
      options.modelsTs = path.resolve(argv[++index]);
    else throw new Error(`unknown argument ${arg}`);
  }
  const lock = await readLock(options.lock);
  const expected = modelsSource(lock);
  if (mode === "write") {
    await writeFile(options.modelsTs, expected);
    console.log(
      `wrote ${path.relative(ROOT, options.modelsTs)} (${modelId(lock)})`
    );
    return;
  }
  if (mode === "check") {
    const actual = existsSync(options.modelsTs)
      ? await readFile(options.modelsTs, "utf8")
      : null;
    if (actual !== expected)
      throw new Error(
        `${path.relative(ROOT, options.modelsTs)} disagrees with the lock file (expected SCANNER_MODEL_ID ${modelId(lock)}); run node scripts/fetch-scanner-models.mjs --write`
      );
    console.log(`scanner models lock ok (${modelId(lock)})`);
    return;
  }
  for (const entry of lock.files) {
    const result = await download(
      entry,
      options.out,
      process.env.SCANNER_MODELS_STUB_DIR
    );
    console.log(`${result}: ${entry.sha256.slice(0, 16)}/${entry.name}`);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`fetch-scanner-models: ${error.message}`);
    process.exit(1);
  });
}

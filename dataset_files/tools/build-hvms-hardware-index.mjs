/**
 * Build hash + vector index from hvms_smartphone_hardware.json (standalone — does not modify the app).
 *
 *   cd dataset_files/tools && npm install && node build-hvms-hardware-index.mjs
 *
 * Output: ../hvms_smartphone_hardware_index.json
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, "..", "hvms_smartphone_hardware.json");
const OUTPUT_PATH = join(__dirname, "..", "hvms_smartphone_hardware_index.json");
const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const BATCH_SIZE = 64;

function normalizeModelKey(model) {
  if (!model || typeof model !== "string") return "";
  return model.trim().toLowerCase().replace(/-/g, "");
}

function recordText(row) {
  const vendor = String(row.hardware_vendor || "").trim();
  const name = String(row.hardware_name || "").trim();
  const model = row.model == null ? "" : String(row.model).trim();
  return [vendor, name, model].filter(Boolean).join(" | ");
}

function recordHash(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function loadEmbedder() {
  const { pipeline } = await import("@xenova/transformers");
  return pipeline("feature-extraction", EMBEDDING_MODEL, { quantized: true });
}

async function embedBatch(extractor, texts) {
  const out = await extractor(texts, { pooling: "mean", normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const rows = texts.length;
  const vectors = [];
  for (let i = 0; i < rows; i++) {
    const row = [];
    const offset = i * dim;
    for (let j = 0; j < dim; j++) {
      row.push(Number(out.data[offset + j].toFixed(6)));
    }
    vectors.push(row);
  }
  return vectors;
}

async function main() {
  console.error("Reading", SOURCE_PATH);
  const source = JSON.parse(readFileSync(SOURCE_PATH, "utf8"));
  const devices = Array.isArray(source.devices) ? source.devices : [];

  const prepared = devices.map((row, index) => {
    const text = recordText(row);
    const modelKey = normalizeModelKey(row.model);
    return {
      index,
      hardware_vendor: row.hardware_vendor ?? null,
      hardware_name: row.hardware_name ?? null,
      model: row.model ?? null,
      modelKey: modelKey || null,
      text,
      hash: recordHash(text),
    };
  });

  console.error(`Embedding ${prepared.length} rows with ${EMBEDDING_MODEL}…`);
  const extractor = await loadEmbedder();
  let dimensions = 0;

  for (let i = 0; i < prepared.length; i += BATCH_SIZE) {
    const batch = prepared.slice(i, i + BATCH_SIZE);
    const texts = batch.map((r) => r.text || "unknown device");
    const vectors = await embedBatch(extractor, texts);
    dimensions = vectors[0]?.length ?? dimensions;
    for (let j = 0; j < batch.length; j++) {
      batch[j].embedding = vectors[j];
    }
    if ((i + BATCH_SIZE) % 512 === 0 || i + BATCH_SIZE >= prepared.length) {
      console.error(`  ${Math.min(i + BATCH_SIZE, prepared.length)} / ${prepared.length}`);
    }
  }

  const uniqueModelKeys = new Set(prepared.map((r) => r.modelKey).filter(Boolean));

  const output = {
    meta: {
      indexVersion: 1,
      sourceFile: "hvms_smartphone_hardware.json",
      sourceMeta: source.meta ?? null,
      generatedAt: new Date().toISOString(),
      hashAlgorithm: "sha256",
      embeddingModel: EMBEDDING_MODEL,
      embeddingDimensions: dimensions,
      entryCount: prepared.length,
      uniqueModelKeyCount: uniqueModelKeys.size,
    },
    entries: prepared.map(({ index, hardware_vendor, hardware_name, model, modelKey, text, hash, embedding }) => ({
      index,
      hardware_vendor,
      hardware_name,
      model,
      modelKey,
      text,
      hash,
      embedding,
    })),
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.error("Wrote", OUTPUT_PATH);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

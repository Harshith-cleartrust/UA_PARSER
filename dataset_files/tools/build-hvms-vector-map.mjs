/**
 * Build a small mapping file: dataset row ↔ vector slot (no embedding numbers).
 * Vectors live in hvms_smartphone_hardware_index.json at the same array index.
 *
 *   node build-hvms-vector-map.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, "..", "hvms_smartphone_hardware.json");
const EMBEDDINGS_PATH = join(__dirname, "..", "hvms_smartphone_hardware_index.json");
const MAP_PATH = join(__dirname, "..", "hvms_smartphone_hardware_vector_map.json");

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

function main() {
  const source = JSON.parse(readFileSync(SOURCE_PATH, "utf8"));
  const devices = Array.isArray(source.devices) ? source.devices : [];

  let embeddingsMeta = null;
  try {
    const emb = JSON.parse(readFileSync(EMBEDDINGS_PATH, "utf8"));
    embeddingsMeta = emb.meta ?? null;
  } catch {
    /* index file optional */
  }

  const mappings = devices.map((row, datasetIndex) => {
    const text = recordText(row);
    const modelKey = normalizeModelKey(row.model);
    return {
      datasetIndex,
      embeddingIndex: datasetIndex,
      hardware_vendor: row.hardware_vendor ?? null,
      hardware_name: row.hardware_name ?? null,
      model: row.model ?? null,
      modelKey: modelKey || null,
      text,
      hash: recordHash(text),
    };
  });

  const uniqueModelKeys = new Set(mappings.map((m) => m.modelKey).filter(Boolean));

  const output = {
    meta: {
      mapVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceFile: "hvms_smartphone_hardware.json",
      sourceMeta: source.meta ?? null,
      embeddingsFile: "hvms_smartphone_hardware_index.json",
      embeddingsMeta,
      hashAlgorithm: "sha256",
      entryCount: mappings.length,
      uniqueModelKeyCount: uniqueModelKeys.size,
      howToResolveEmbedding:
        "embedding[i] in hvms_smartphone_hardware_index.json ↔ devices[i] in hvms_smartphone_hardware.json (same index)",
    },
    mappings,
  };

  writeFileSync(MAP_PATH, JSON.stringify(output, null, 2));
  console.error("Wrote", MAP_PATH, `(${mappings.length} rows)`);
}

main();

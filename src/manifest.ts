import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config";
import type { Manifest } from "./types";
import { log, logError } from "./utils";

export function createManifest(config: Config): Manifest {
  const manifestPath = path.join(config.dumpDir, "manifest.json");
  if (existsSync(manifestPath)) {
    try {
      const existing = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
      log(`Loaded existing manifest for resumable migration: ${manifestPath}`);
      return {
        ...existing,
        fromAccountId: config.fromAccountId,
        toAccountId: config.toAccountId,
        fromZoneId: config.fromZoneId,
        toZoneId: config.toZoneId,
      };
    } catch (error) {
      logError(
        `Could not read existing manifest (${error instanceof Error ? error.message : String(error)}); starting a new manifest.`,
      );
    }
  }
  return {
    startedAt: new Date().toISOString(),
    fromAccountId: config.fromAccountId,
    toAccountId: config.toAccountId,
    fromZoneId: config.fromZoneId,
    toZoneId: config.toZoneId,
    images: [],
    stream: [],
    kv: [],
    r2: [],
    site: [],
    errors: [],
  };
}

export async function prepareDumpDirs(config: Config) {
  await mkdir(config.dumpDir, { recursive: true });
  await Promise.all(
    ["images", "stream", "kv", "r2", "site"].map((dir) => mkdir(path.join(config.dumpDir, dir), { recursive: true })),
  );
}

export async function writeManifest(config: Config, manifest: Manifest) {
  await Bun.write(path.join(config.dumpDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function logMigrationSummary(config: Config, manifest: Manifest) {
  const counts = [
    ["images", manifest.images] as const,
    ["stream", manifest.stream] as const,
    ["kv", manifest.kv] as const,
    ["r2", manifest.r2] as const,
    ["site", manifest.site] as const,
  ].map(([product, records]) => {
    const errors = records.filter((record) => record.error).length;
    return `${product}: ${records.length} processed, ${errors} failed`;
  });
  log(`Migration summary: ${counts.join("; ")}. Manifest: ${path.join(config.dumpDir, "manifest.json")}`);
  if (manifest.errors.length > 0)
    logError(`Migration completed with ${manifest.errors.length} error(s); see manifest for details.`);
}

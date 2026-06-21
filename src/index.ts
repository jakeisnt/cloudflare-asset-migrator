#!/usr/bin/env bun
/**
 * Cloudflare account/site migrator.
 *
 * Cloudflare does not directly transfer a zone between accounts. Per the
 * Cloudflare community guidance, the target account must add the site, recreate
 * DNS/config/resources, and only then should the registrar nameservers be
 * changed to the target account's assigned nameservers.
 */

import { Command } from "commander";
import { createConfig } from "./config";
import { createManifest, logMigrationSummary, prepareDumpDirs, writeManifest } from "./manifest";
import { migrateImages, migrateKv, migrateR2, migrateStream } from "./products/assets";
import { migrateSiteProducts } from "./products/site";
import type { Manifest, Product } from "./types";
import { errorMessage, log, logError } from "./utils";

const program = new Command();

program
  .name("cloudflare-asset-migrator")
  .description("Copy Cloudflare Images, Stream, KV, R2, and zone-level site configuration between accounts.")
  .option("--from-account-id <id>", "source Cloudflare account ID (env: CF_FROM_ACCOUNT_ID)")
  .option("--from-token <token>", "source Cloudflare API token (env: CF_FROM_API_TOKEN)")
  .option("--to-account-id <id>", "target Cloudflare account ID (env: CF_TO_ACCOUNT_ID)")
  .option("--to-token <token>", "target Cloudflare API token (env: CF_TO_API_TOKEN)")
  .option("--from-zone-id <id>", "source zone ID for site products (env: CF_FROM_ZONE_ID)")
  .option("--to-zone-id <id>", "target zone ID for site products after adding the site (env: CF_TO_ZONE_ID)")
  .option("--zone-name <name>", "domain name for docs/checklists (env: CF_ZONE_NAME)")
  .option("--dump-dir <path>", "local dump/manifest directory (env: CF_ASSET_DUMP_DIR)")
  .option(
    "--products <list>",
    "comma-separated products: images,stream,kv,r2,dns,zone-settings,page-rules,rulesets,workers-routes,custom-hostnames (env: CF_MIGRATE)",
  )
  .option("--kv-namespace-map <pairs>", "fromNamespaceOrTitle:toNamespaceOrTitle pairs (env: CF_KV_NAMESPACE_MAP)")
  .option("--r2-bucket-map <pairs>", "fromBucket:toBucket pairs (env: CF_R2_BUCKET_MAP)")
  .option("--r2-bucket <name>", "shortcut for same-name R2 bucket copy (env: CF_R2_BUCKET)")
  .option(
    "--retry-failed <list>",
    "comma-separated products whose failed manifest records should be retried, e.g. stream,images (env: CF_MIGRATE_RETRY_FAILED)",
  )
  .option("--dry-run", "download/dump and plan mutations without writing target account", false)
  .action(async (options) => {
    const config = createConfig(options);
    const manifest = createManifest(config);
    const context = { config };

    log(
      `Starting Cloudflare migration. products=${[...config.products].join(",")} retryFailed=${[...config.retryFailedProducts].join(",") || "none"} dumpDir=${config.dumpDir} dryRun=${config.dryRun}`,
    );
    await prepareDumpDirs(config);

    try {
      if (config.products.has("images")) await runProduct("images", manifest, () => migrateImages(context, manifest));
      if (config.products.has("stream")) await runProduct("stream", manifest, () => migrateStream(context, manifest));
      if (config.products.has("kv")) await runProduct("kv", manifest, () => migrateKv(context, manifest));
      if (config.products.has("r2")) await runProduct("r2", manifest, () => migrateR2(context, manifest));
      await migrateSiteProducts(context, manifest);
    } finally {
      manifest.finishedAt = new Date().toISOString();
      await writeManifest(config, manifest);
      logMigrationSummary(config, manifest);
      if (manifest.errors.length > 0) process.exitCode = 1;
    }
  });

async function runProduct(product: Product, manifest: Manifest, run: () => Promise<void>) {
  try {
    await run();
  } catch (error) {
    const message = errorMessage(error);
    manifest.errors.push({ product, error: message });
    logError(`${product}: stopped this pipeline after error: ${message}`);
    log(`${product}: continuing with remaining selected product pipelines.`);
  }
}

try {
  await program.parseAsync();
} catch (error) {
  logError(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

import type { Pair, Product } from "./types";
import { booleanFromValue, bucketMapFromSingle, numberFromValue, parsePairMap } from "./utils";

export type Config = {
  fromAccountId: string;
  fromToken: string;
  toAccountId: string;
  toToken: string;
  fromZoneId?: string;
  toZoneId?: string;
  zoneName?: string;
  dumpDir: string;
  products: Set<Product>;
  retryFailedProducts: Set<Product>;
  kvNamespaceMap: Pair[];
  r2BucketMap: Pair[];
  fromR2ParentAccessKeyId?: string;
  toR2ParentAccessKeyId?: string;
  fromStreamCustomerCode?: string;
  toStreamCustomerCode?: string;
  fromImagesAccountHash?: string;
  toImagesAccountHash?: string;
  streamDownloadReadyTimeoutMs: number;
  streamPollMs: number;
  streamTransferTimeoutMs: number;
  transferTimeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  requestTimeoutMs: number;
  dryRun: boolean;
};

type CliOptions = {
  fromAccountId?: string;
  fromToken?: string;
  toAccountId?: string;
  toToken?: string;
  fromZoneId?: string;
  toZoneId?: string;
  zoneName?: string;
  dumpDir?: string;
  products?: string;
  retryFailed?: string;
  kvNamespaceMap?: string;
  r2BucketMap?: string;
  r2Bucket?: string;
  dryRun?: boolean;
};

const allProducts = new Set<Product>([
  "images",
  "stream",
  "kv",
  "r2",
  "dns",
  "zone-settings",
  "page-rules",
  "rulesets",
  "workers-routes",
  "custom-hostnames",
]);

export function createConfig(options: CliOptions): Config {
  const retryFailedProducts = parseProducts(options.retryFailed ?? process.env.CF_MIGRATE_RETRY_FAILED ?? "");
  const products = parseProducts(
    options.products ??
      process.env.CF_MIGRATE ??
      (retryFailedProducts.size > 0 ? [...retryFailedProducts].join(",") : "images,stream"),
  );
  return {
    fromAccountId: required("from account", options.fromAccountId ?? process.env.CF_FROM_ACCOUNT_ID),
    fromToken: required("from token", options.fromToken ?? process.env.CF_FROM_API_TOKEN),
    toAccountId: required("to account", options.toAccountId ?? process.env.CF_TO_ACCOUNT_ID),
    toToken: required("to token", options.toToken ?? process.env.CF_TO_API_TOKEN),
    fromZoneId: options.fromZoneId ?? process.env.CF_FROM_ZONE_ID,
    toZoneId: options.toZoneId ?? process.env.CF_TO_ZONE_ID,
    zoneName: options.zoneName ?? process.env.CF_ZONE_NAME,
    dumpDir: options.dumpDir ?? process.env.CF_ASSET_DUMP_DIR ?? "cloudflare-asset-dump",
    products,
    retryFailedProducts,
    kvNamespaceMap: parsePairMap(options.kvNamespaceMap ?? process.env.CF_KV_NAMESPACE_MAP),
    r2BucketMap: parsePairMap(
      options.r2BucketMap ??
        process.env.CF_R2_BUCKET_MAP ??
        bucketMapFromSingle(options.r2Bucket ?? process.env.CF_R2_BUCKET),
    ),
    fromR2ParentAccessKeyId: process.env.CF_FROM_R2_PARENT_ACCESS_KEY_ID,
    toR2ParentAccessKeyId: process.env.CF_TO_R2_PARENT_ACCESS_KEY_ID,
    fromStreamCustomerCode: process.env.CF_FROM_STREAM_CUSTOMER_CODE,
    toStreamCustomerCode: process.env.CF_TO_STREAM_CUSTOMER_CODE,
    fromImagesAccountHash: process.env.CF_FROM_IMAGES_ACCOUNT_HASH,
    toImagesAccountHash: process.env.CF_TO_IMAGES_ACCOUNT_HASH,
    streamDownloadReadyTimeoutMs: numberFromValue(
      "CF_STREAM_DOWNLOAD_READY_TIMEOUT_MS",
      process.env.CF_STREAM_DOWNLOAD_READY_TIMEOUT_MS ?? process.env.CF_STREAM_DOWNLOAD_TIMEOUT_MS,
      1_200_000,
    ),
    streamPollMs: numberFromValue("CF_STREAM_DOWNLOAD_POLL_MS", process.env.CF_STREAM_DOWNLOAD_POLL_MS, 5_000),
    streamTransferTimeoutMs: numberFromValue(
      "CF_STREAM_TRANSFER_TIMEOUT_MS",
      process.env.CF_STREAM_TRANSFER_TIMEOUT_MS,
      1_800_000,
    ),
    transferTimeoutMs: numberFromValue(
      "CF_MIGRATE_TRANSFER_TIMEOUT_MS",
      process.env.CF_MIGRATE_TRANSFER_TIMEOUT_MS,
      300_000,
    ),
    maxRetries: numberFromValue("CF_MIGRATE_MAX_RETRIES", process.env.CF_MIGRATE_MAX_RETRIES, 8),
    retryBaseMs: numberFromValue("CF_MIGRATE_RETRY_BASE_MS", process.env.CF_MIGRATE_RETRY_BASE_MS, 1_000),
    retryMaxMs: numberFromValue("CF_MIGRATE_RETRY_MAX_MS", process.env.CF_MIGRATE_RETRY_MAX_MS, 60_000),
    requestTimeoutMs: numberFromValue(
      "CF_MIGRATE_REQUEST_TIMEOUT_MS",
      process.env.CF_MIGRATE_REQUEST_TIMEOUT_MS,
      120_000,
    ),
    dryRun: booleanFromValue(options.dryRun ?? process.env.CF_MIGRATE_DRY_RUN),
  };
}

export function assertZoneConfig(config: Config) {
  if (!config.fromZoneId || !config.toZoneId) {
    throw new Error(
      "Site products require CF_FROM_ZONE_ID and CF_TO_ZONE_ID (or --from-zone-id/--to-zone-id). Add the zone to the target account first, then change registrar nameservers after verification.",
    );
  }
}

function parseProducts(value: string) {
  const selected = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean) as Product[];
  for (const product of selected) {
    if (!allProducts.has(product))
      throw new Error(`Unknown product '${product}'. Valid products: ${[...allProducts].join(",")}`);
  }
  return new Set(selected);
}

function required(label: string, value: string | undefined) {
  if (!value) throw new Error(`Missing required ${label}. Set env vars or pass CLI flags; run --help for details.`);
  return value;
}

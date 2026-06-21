import { z } from "zod";
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

const optionalEnvString = z.string().trim().min(1).optional();
const positiveNumberEnv = z
  .string()
  .trim()
  .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, "must be a positive number")
  .optional();
const booleanEnv = z.enum(["1", "0", "true", "false", "yes", "no", "on", "off"]).optional();

const envSchema = z
  .object({
    CF_FROM_ACCOUNT_ID: optionalEnvString,
    CF_FROM_API_TOKEN: optionalEnvString,
    CF_TO_ACCOUNT_ID: optionalEnvString,
    CF_TO_API_TOKEN: optionalEnvString,
    CF_FROM_ZONE_ID: optionalEnvString,
    CF_TO_ZONE_ID: optionalEnvString,
    CF_ZONE_NAME: optionalEnvString,
    CF_ASSET_DUMP_DIR: optionalEnvString,
    CF_MIGRATE: optionalEnvString,
    CF_MIGRATE_RETRY_FAILED: optionalEnvString,
    CF_KV_NAMESPACE_MAP: optionalEnvString,
    CF_R2_BUCKET_MAP: optionalEnvString,
    CF_R2_BUCKET: optionalEnvString,
    CF_FROM_R2_PARENT_ACCESS_KEY_ID: optionalEnvString,
    CF_TO_R2_PARENT_ACCESS_KEY_ID: optionalEnvString,
    CF_FROM_STREAM_CUSTOMER_CODE: optionalEnvString,
    CF_TO_STREAM_CUSTOMER_CODE: optionalEnvString,
    CF_FROM_IMAGES_ACCOUNT_HASH: optionalEnvString,
    CF_TO_IMAGES_ACCOUNT_HASH: optionalEnvString,
    CF_STREAM_DOWNLOAD_READY_TIMEOUT_MS: positiveNumberEnv,
    CF_STREAM_DOWNLOAD_TIMEOUT_MS: positiveNumberEnv,
    CF_STREAM_DOWNLOAD_POLL_MS: positiveNumberEnv,
    CF_STREAM_TRANSFER_TIMEOUT_MS: positiveNumberEnv,
    CF_MIGRATE_TRANSFER_TIMEOUT_MS: positiveNumberEnv,
    CF_MIGRATE_MAX_RETRIES: positiveNumberEnv,
    CF_MIGRATE_RETRY_BASE_MS: positiveNumberEnv,
    CF_MIGRATE_RETRY_MAX_MS: positiveNumberEnv,
    CF_MIGRATE_REQUEST_TIMEOUT_MS: positiveNumberEnv,
    CF_MIGRATE_DRY_RUN: booleanEnv,
  })
  .passthrough();

type Env = z.infer<typeof envSchema>;

export function createConfig(options: CliOptions): Config {
  const env = parseEnv(process.env);
  const retryFailedProducts = parseProducts(options.retryFailed ?? env.CF_MIGRATE_RETRY_FAILED ?? "");
  const products = parseProducts(
    options.products ?? env.CF_MIGRATE ?? (retryFailedProducts.size > 0 ? [...retryFailedProducts].join(",") : "images,stream"),
  );
  return {
    fromAccountId: required("from account", options.fromAccountId ?? env.CF_FROM_ACCOUNT_ID),
    fromToken: required("from token", options.fromToken ?? env.CF_FROM_API_TOKEN),
    toAccountId: required("to account", options.toAccountId ?? env.CF_TO_ACCOUNT_ID),
    toToken: required("to token", options.toToken ?? env.CF_TO_API_TOKEN),
    fromZoneId: options.fromZoneId ?? env.CF_FROM_ZONE_ID,
    toZoneId: options.toZoneId ?? env.CF_TO_ZONE_ID,
    zoneName: options.zoneName ?? env.CF_ZONE_NAME,
    dumpDir: options.dumpDir ?? env.CF_ASSET_DUMP_DIR ?? "cloudflare-asset-dump",
    products,
    retryFailedProducts,
    kvNamespaceMap: parsePairMap(options.kvNamespaceMap ?? env.CF_KV_NAMESPACE_MAP),
    r2BucketMap: parsePairMap(
      options.r2BucketMap ?? env.CF_R2_BUCKET_MAP ?? bucketMapFromSingle(options.r2Bucket ?? env.CF_R2_BUCKET),
    ),
    fromR2ParentAccessKeyId: env.CF_FROM_R2_PARENT_ACCESS_KEY_ID,
    toR2ParentAccessKeyId: env.CF_TO_R2_PARENT_ACCESS_KEY_ID,
    fromStreamCustomerCode: env.CF_FROM_STREAM_CUSTOMER_CODE,
    toStreamCustomerCode: env.CF_TO_STREAM_CUSTOMER_CODE,
    fromImagesAccountHash: env.CF_FROM_IMAGES_ACCOUNT_HASH,
    toImagesAccountHash: env.CF_TO_IMAGES_ACCOUNT_HASH,
    streamDownloadReadyTimeoutMs: numberFromValue(
      "CF_STREAM_DOWNLOAD_READY_TIMEOUT_MS",
      env.CF_STREAM_DOWNLOAD_READY_TIMEOUT_MS ?? env.CF_STREAM_DOWNLOAD_TIMEOUT_MS,
      1_200_000,
    ),
    streamPollMs: numberFromValue("CF_STREAM_DOWNLOAD_POLL_MS", env.CF_STREAM_DOWNLOAD_POLL_MS, 5_000),
    streamTransferTimeoutMs: numberFromValue(
      "CF_STREAM_TRANSFER_TIMEOUT_MS",
      env.CF_STREAM_TRANSFER_TIMEOUT_MS,
      1_800_000,
    ),
    transferTimeoutMs: numberFromValue(
      "CF_MIGRATE_TRANSFER_TIMEOUT_MS",
      env.CF_MIGRATE_TRANSFER_TIMEOUT_MS,
      300_000,
    ),
    maxRetries: numberFromValue("CF_MIGRATE_MAX_RETRIES", env.CF_MIGRATE_MAX_RETRIES, 8),
    retryBaseMs: numberFromValue("CF_MIGRATE_RETRY_BASE_MS", env.CF_MIGRATE_RETRY_BASE_MS, 1_000),
    retryMaxMs: numberFromValue("CF_MIGRATE_RETRY_MAX_MS", env.CF_MIGRATE_RETRY_MAX_MS, 60_000),
    requestTimeoutMs: numberFromValue("CF_MIGRATE_REQUEST_TIMEOUT_MS", env.CF_MIGRATE_REQUEST_TIMEOUT_MS, 120_000),
    dryRun: booleanFromValue(options.dryRun ?? env.CF_MIGRATE_DRY_RUN),
  };
}

function parseEnv(env: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(env);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Invalid environment configuration: ${issues}`);
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

export const API = "https://api.cloudflare.com/client/v4";

export type Side = "from" | "to";
export type Product =
  | "images"
  | "stream"
  | "kv"
  | "r2"
  | "dns"
  | "zone-settings"
  | "page-rules"
  | "rulesets"
  | "workers-routes"
  | "custom-hostnames";
export type Pair = readonly [string, string];

export type CloudflareEnvelope = {
  success?: boolean;
  errors?: unknown[];
  messages?: unknown[];
  result?: unknown;
  result_info?: { cursor?: string; total_count?: number; total_pages?: number };
  total?: number;
  images?: unknown[];
  videos?: unknown[];
};

export type CloudflareError = Error & {
  status?: number;
  body?: string;
  cloudflareErrors?: unknown[];
  retryAfterMs?: number;
};

export type HttpError = Error & {
  status?: number;
  body?: string;
  retryAfterMs?: number;
};

export type ResponseData = {
  bytes: Uint8Array;
  contentType: string;
};

export type ImageRecord = {
  id: string;
  filename: string | null;
  localPath: string;
  uploadedId: string | null;
  skipped: boolean;
  error?: string;
};

export type StreamRecord = {
  uid: string;
  name: string;
  localPath: string;
  downloadUrl: string | null;
  uploadedUid: string | null;
  size?: number;
  error?: string;
};

export type KvRecord = {
  fromNamespaceId: string;
  toNamespaceId: string;
  key: string;
  localPath: string;
  error?: string;
};

export type R2Record = {
  fromBucket: string;
  toBucket: string;
  key: string;
  localPath: string;
  size: number;
  error?: string;
};

export type SiteRecord = {
  product: Exclude<Product, "images" | "stream" | "kv" | "r2">;
  id: string;
  action: "created" | "updated" | "skipped" | "planned";
  error?: string;
};

export type ManifestError = { product: Product; id?: string; uid?: string; key?: string; error: string };

export type Manifest = {
  startedAt: string;
  finishedAt?: string;
  fromAccountId: string;
  toAccountId: string;
  fromZoneId?: string;
  toZoneId?: string;
  images: ImageRecord[];
  stream: StreamRecord[];
  kv: KvRecord[];
  r2: R2Record[];
  site: SiteRecord[];
  errors: ManifestError[];
};

export type ImageItem = {
  id?: unknown;
  filename?: unknown;
  metadata?: unknown;
  requireSignedURLs?: unknown;
};

export type StreamItem = {
  uid?: unknown;
  meta?: { name?: unknown; filename?: unknown } & Record<string, unknown>;
  requireSignedURLs?: unknown;
  allowedOrigins?: unknown;
  thumbnailTimestampPct?: unknown;
};

export type KvNamespace = { id?: unknown; title?: unknown };
export type KvKeyInfo = { name?: unknown };
export type R2Credentials = { accountId: string; accessKeyId: string; secretAccessKey: string; sessionToken: string };
export type R2ObjectInfo = { key: string; size: number };
export type ListBucketResult = { objects: R2ObjectInfo[]; nextContinuationToken?: string };

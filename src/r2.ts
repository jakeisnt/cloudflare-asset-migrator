import { createHash, createHmac } from "node:crypto";
import type { ApiContext } from "./api";
import { cfJson, fetchWithTimeout, retry } from "./api";
import type { ListBucketResult, R2Credentials, Side } from "./types";
import { stringValue } from "./utils";

export async function createR2TemporaryCredentials(
  context: ApiContext,
  side: Side,
  bucket: string,
  permission: string,
) {
  const accountId = side === "from" ? context.config.fromAccountId : context.config.toAccountId;
  const parentAccessKeyId =
    side === "from" ? context.config.fromR2ParentAccessKeyId : context.config.toR2ParentAccessKeyId;
  const body: Record<string, string | number> = { bucket, permission, ttlSeconds: 3600 };
  if (parentAccessKeyId) body.parentAccessKeyId = parentAccessKeyId;
  const result = (await cfJson(context, side, `/accounts/${accountId}/r2/temp-access-credentials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })) as Record<string, unknown>;
  const credentials: R2Credentials = {
    accountId,
    accessKeyId: stringValue(result.accessKeyId) ?? "",
    secretAccessKey: stringValue(result.secretAccessKey) ?? "",
    sessionToken: stringValue(result.sessionToken) ?? "",
  };
  if (!credentials.accessKeyId || !credentials.secretAccessKey || !credentials.sessionToken) {
    throw new Error(`Cloudflare did not return complete temporary R2 credentials for ${side} bucket ${bucket}`);
  }
  return credentials;
}

export async function r2ListObjects(
  context: ApiContext,
  side: Side,
  bucket: string,
  credentials: R2Credentials,
  continuationToken?: string,
) {
  const query: Record<string, string> = { "list-type": "2" };
  if (continuationToken) query["continuation-token"] = continuationToken;
  const response = await r2Fetch(context, side, "GET", bucket, "", credentials, { query });
  return parseListBucketResult(await response.text());
}

export async function r2Fetch(
  context: ApiContext,
  side: Side,
  method: "GET" | "PUT",
  bucket: string,
  key: string,
  credentials: R2Credentials,
  options: { query?: Record<string, string>; body?: Uint8Array; contentType?: string } = {},
) {
  const host = `${credentials.accountId}.r2.cloudflarestorage.com`;
  const pathname = `/${encodePathSegment(bucket)}${key ? `/${encodePath(key)}` : ""}`;
  const query = options.query ?? {};
  const url = new URL(`https://${host}${pathname}`);
  url.search = canonicalQuery(query);

  return retry(context, `R2 ${side} ${method} ${bucket}/${key || "<bucket>"}`, async () => {
    const body = options.body;
    const payloadHash = sha256Hex(body ?? "");
    const now = new Date();
    const amzDate = formatAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (options.contentType) headers["content-type"] = options.contentType;
    headers["x-amz-security-token"] = credentials.sessionToken;

    const authorization = signAwsRequest({
      method,
      pathname,
      query,
      headers,
      payloadHash,
      credentials,
      dateStamp,
      amzDate,
    });
    const response = await fetchWithTimeout(context, url, { method, headers: { ...headers, authorization }, body });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(
        `R2 ${side} ${method} ${bucket}/${key} failed: ${response.status} ${response.statusText}${text ? ` ${text}` : ""}`,
      ) as Error & { status?: number; body?: string; retryAfterMs?: number };
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return response;
  });
}

function signAwsRequest(input: {
  method: string;
  pathname: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
  credentials: R2Credentials;
  dateStamp: string;
  amzDate: string;
}) {
  const sortedHeaderNames = Object.keys(input.headers).sort();
  const canonicalHeaders = sortedHeaderNames.map((name) => `${name}:${input.headers[name]?.trim() ?? ""}\n`).join("");
  const signedHeaders = sortedHeaderNames.join(";");
  const credentialScope = `${input.dateStamp}/auto/s3/aws4_request`;
  const canonicalRequest = [
    input.method,
    input.pathname,
    canonicalQuery(input.query),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${input.credentials.secretAccessKey}`, input.dateStamp), "auto"), "s3"),
    "aws4_request",
  );
  const signature = hmac(signingKey, stringToSign, "hex");
  return `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function canonicalQuery(query: Record<string, string>) {
  return Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join("&");
}

function parseListBucketResult(xml: string): ListBucketResult {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((match) => {
    const body = match[1] ?? "";
    return { key: decodeXml(extractXml(body, "Key") ?? ""), size: Number(extractXml(body, "Size") ?? 0) };
  });
  return { objects, nextContinuationToken: decodeXml(extractXml(xml, "NextContinuationToken") ?? "") || undefined };
}

function extractXml(xml: string, tag: string) {
  return xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1];
}

function decodeXml(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function encodePath(pathValue: string) {
  return pathValue.split("/").map(encodePathSegment).join("/");
}

function encodePathSegment(value: string) {
  return encodeRfc3986(value);
}

function encodeRfc3986(value: string | number) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string, encoding?: "hex") {
  return createHmac("sha256", key).update(value).digest(encoding);
}

function formatAmzDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

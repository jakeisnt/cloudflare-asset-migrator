import type { Config } from "./config";
import { API, type CloudflareEnvelope, type CloudflareError, type HttpError, type Side } from "./types";
import {
  errorMessage,
  errorStatus,
  itemsFromPaginatedResponse,
  logError,
  numberValue,
  requestLabel,
  resultInfo,
} from "./utils";

export type ApiContext = { config: Config };

export async function listPaginated(fetchPage: (page: number, perPage: number) => Promise<unknown>) {
  const items: unknown[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const response = await fetchPage(page, perPage);
    const result = itemsFromPaginatedResponse(response);
    items.push(...result);

    const info = resultInfo(response);
    const responseRecord =
      response && typeof response === "object" && !Array.isArray(response) ? (response as Record<string, unknown>) : {};
    const total = typeof responseRecord.total === "number" ? responseRecord.total : numberValue(info.total_count);
    const totalPages = numberValue(info.total_pages);
    if (totalPages !== undefined) {
      if (page >= totalPages) break;
    } else if (total !== undefined) {
      if (items.length >= total || result.length === 0) break;
    } else if (result.length < perPage) {
      break;
    }
    page += 1;
  }

  return items;
}

export async function cfJson(context: ApiContext, side: Side, endpoint: string, init: RequestInit = {}) {
  return retry(context, `Cloudflare ${side} JSON ${requestLabel(init.method, endpoint)}`, async () => {
    const response = await cfFetch(context, side, endpoint, init);
    const json = (await response.json()) as CloudflareEnvelope;
    if (json.success === false) {
      const error = new Error(`Cloudflare API error: ${JSON.stringify(json.errors)}`) as CloudflareError;
      error.cloudflareErrors = json.errors;
      throw error;
    }
    if (Array.isArray(json.result)) {
      const result = json.result as unknown[] & { result_info?: CloudflareEnvelope["result_info"] };
      result.result_info = json.result_info;
      return result;
    }
    return json.result ?? json;
  });
}

export async function cfFetch(context: ApiContext, side: Side, endpoint: string, init: RequestInit = {}) {
  return retry(context, `Cloudflare ${side} ${requestLabel(init.method, endpoint)}`, async () => {
    const token = side === "from" ? context.config.fromToken : context.config.toToken;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetchWithTimeout(context, `${API}${endpoint}`, { ...init, headers });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = new Error(
        `Cloudflare ${side} request failed: ${response.status} ${response.statusText}${body ? ` ${body}` : ""}`,
      ) as CloudflareError;
      error.status = response.status;
      error.body = body;
      error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"));
      throw error;
    }

    return response;
  });
}

export async function httpFetch(context: ApiContext, url: string, init: RequestInit = {}) {
  return retry(context, `HTTP ${requestLabel(init.method, url)}`, async () => {
    const response = await fetchWithTimeout(context, url, init);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const error = new Error(
        `HTTP request failed: ${response.status} ${response.statusText}${body ? ` ${body}` : ""}`,
      ) as HttpError;
      error.status = response.status;
      error.body = body;
      error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"));
      throw error;
    }
    return response;
  });
}

export async function fetchWithTimeout(context: ApiContext, input: string | URL, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), context.config.requestTimeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function retry<T>(context: ApiContext, label: string, operation: () => Promise<T>): Promise<T> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt < context.config.maxRetries) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= context.config.maxRetries || !isRetryableError(error)) break;
      const delayMs = retryDelayMs(context, error, attempt);
      logError(
        `${label} failed (attempt ${attempt}/${context.config.maxRetries}); retrying in ${delayMs}ms: ${errorMessage(error)}`,
      );
      await Bun.sleep(delayMs);
    }
  }
  throw lastError;
}

function isRetryableError(error: unknown) {
  return errorStatus(error) === 429;
}

function retryDelayMs(context: ApiContext, error: unknown, attempt: number) {
  const retryAfter = error instanceof Error && "retryAfterMs" in error ? error.retryAfterMs : undefined;
  if (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;
  const exponential = context.config.retryBaseMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * context.config.retryBaseMs);
  return Math.min(context.config.retryMaxMs, exponential + jitter);
}

function retryAfterMs(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : undefined;
}

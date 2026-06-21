import type { Config } from "./config";
import { API, type CloudflareEnvelope, type CloudflareError, type HttpError, type Side } from "./types";
import {
  asRecord,
  errorMessage,
  errorStatus,
  itemsFromPaginatedResponse,
  logError,
  numberValue,
  requestLabel,
  resultInfo,
  stringValue,
} from "./utils";

export type ApiContext = { config: Config; tokenEmails?: Partial<Record<Side, string | null>> };
export type ApiRequestInit = RequestInit & { noRetry?: boolean; timeoutMs?: number };

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

export async function cfJson(context: ApiContext, side: Side, endpoint: string, init: ApiRequestInit = {}) {
  return retry(context, `Cloudflare ${side} JSON ${requestLabel(init.method, endpoint)}`, async () => {
    const response = await cfFetch(context, side, endpoint, init);
    return parseCloudflareJson(context, side, endpoint, init.method, response);
  });
}

export async function cfFetch(context: ApiContext, side: Side, endpoint: string, init: ApiRequestInit = {}) {
  const operation = async () => {
    const token = side === "from" ? context.config.fromToken : context.config.toToken;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetchWithTimeout(context, `${API}${endpoint}`, { ...init, headers });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const message = await cloudflareErrorMessage(
        context,
        side,
        endpoint,
        init.method,
        response.status,
        response.statusText,
        body,
      );
      const error = new Error(message) as CloudflareError;
      error.status = response.status;
      error.body = body;
      error.retryAfterMs = retryAfterMs(response.headers.get("retry-after"));
      throw error;
    }

    return response;
  };
  if (init.noRetry) return operation();
  return retry(context, `Cloudflare ${side} ${requestLabel(init.method, endpoint)}`, operation);
}

export async function parseCloudflareJson(
  context: ApiContext,
  side: Side,
  endpoint: string,
  method: string | undefined,
  response: Response,
) {
  const json = (await response.json()) as CloudflareEnvelope;
  if (json.success === false) {
    const message = await cloudflareErrorMessage(context, side, endpoint, method, undefined, "", json.errors);
    const error = new Error(message) as CloudflareError;
    error.cloudflareErrors = json.errors;
    throw error;
  }
  if (Array.isArray(json.result)) {
    const result = json.result as unknown[] & { result_info?: CloudflareEnvelope["result_info"] };
    result.result_info = json.result_info;
    return result;
  }
  return json.result ?? json;
}

export async function httpFetch(context: ApiContext, url: string, init: ApiRequestInit = {}) {
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

export async function fetchWithTimeout(context: ApiContext, input: string | URL, init: ApiRequestInit = {}) {
  const { noRetry: _noRetry, timeoutMs, ...fetchInit } = init;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? context.config.requestTimeoutMs);
  try {
    return await fetch(input, { ...fetchInit, signal: controller.signal });
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

async function cloudflareErrorMessage(
  context: ApiContext,
  side: Side,
  endpoint: string,
  method: string | undefined,
  status: number | undefined,
  statusText: string,
  bodyOrErrors: unknown,
) {
  const base = `Cloudflare ${side} request failed: ${status ? `${status} ${statusText}` : "API error"}${
    bodyOrErrors ? ` ${stringifyErrorDetails(bodyOrErrors)}` : ""
  }`;
  if (!isPermissionFailure(status, bodyOrErrors)) return base;

  const sideLabel = side === "from" ? "source" : "target";
  const accountId = side === "from" ? context.config.fromAccountId : context.config.toAccountId;
  const email = await tokenEmail(context, side);
  const owner = email ? `${email}` : "unknown email (the token could not read /user)";
  return `${base}\nPermission failure details: Cloudflare denied ${requestLabel(method, endpoint)} for the ${sideLabel} account ${accountId} using API token owner ${owner}.\nSuggested fix: ${permissionSuggestion(side, endpoint)}`;
}

function stringifyErrorDetails(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isPermissionFailure(status: number | undefined, bodyOrErrors: unknown) {
  if (status === 401 || status === 403) return true;
  const text = stringifyErrorDetails(bodyOrErrors).toLowerCase();
  return (
    text.includes("permission") ||
    text.includes("not authorized") ||
    text.includes("unauthorized") ||
    text.includes("authentication error") ||
    text.includes("requires authorization")
  );
}

function permissionSuggestion(side: Side, endpoint: string) {
  const access = side === "from" ? "read/list access on the source account" : "edit/write access on the target account";
  if (endpoint.includes("/images/"))
    return `create or update the token for a member of that account with Cloudflare Images ${side === "from" ? "Read" : "Edit"} permission, confirm the account ID is correct, then rerun. If the error mentions service limit 5453, enable/upgrade Cloudflare Images on the target account or switch to the account that has Images quota.`;
  if (endpoint.includes("/stream"))
    return `create or update the token for a member of that account with Stream Edit permission and confirm the account ID is correct. Source Stream migrations also need write/edit permission because the migrator must POST to create downloadable MP4 renditions before copying videos.`;
  if (endpoint.includes("/storage/kv"))
    return `create or update the token for a member of that account with Workers KV Storage ${side === "from" ? "Read" : "Edit"} permission and confirm the namespace/account IDs are correct.`;
  if (endpoint.includes("/r2/"))
    return `create or update the token for a member of that account with R2 ${side === "from" ? "Read" : "Edit"} permission and confirm the bucket/account IDs are correct.`;
  if (endpoint.startsWith("/zones/"))
    return `create or update the token for a member of that account with the needed Zone permissions (${access}) for DNS/settings/rules/routes on this zone, and confirm the zone ID belongs to that account.`;
  return `create or update the token for a member of that account with ${access} for this Cloudflare product, then confirm the account/zone ID is correct.`;
}

async function tokenEmail(context: ApiContext, side: Side) {
  context.tokenEmails ??= {};
  if (side in context.tokenEmails) return context.tokenEmails[side];
  const token = side === "from" ? context.config.fromToken : context.config.toToken;
  try {
    const response = await fetchWithTimeout(context, `${API}/user`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) {
      context.tokenEmails[side] = null;
      return null;
    }
    const json = (await response.json()) as CloudflareEnvelope;
    const email = stringValue(asRecord(json.result).email);
    context.tokenEmails[side] = email ?? null;
    return context.tokenEmails[side];
  } catch {
    context.tokenEmails[side] = null;
    return null;
  }
}

function isRetryableError(error: unknown) {
  const status = errorStatus(error);
  if (status !== undefined) return status === 408 || status === 409 || status === 425 || status >= 500;
  if (!(error instanceof Error)) return false;
  const name = error.name.toLowerCase();
  const message = error.message.toLowerCase();
  return (
    name.includes("abort") ||
    message.includes("aborted") ||
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("socket") ||
    message.includes("network") ||
    message.includes("fetch failed")
  );
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

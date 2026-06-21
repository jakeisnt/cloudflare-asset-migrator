export function parsePairMap(value: string | undefined) {
  if (!value) return [];
  return value
    .split(",")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const parts = pair.split(":").map((part) => part.trim());
      const from = parts[0];
      const to = parts[1];
      if (!from || !to) throw new Error(`Invalid pair map entry: ${pair}`);
      return [from, to] as const;
    });
}

export function bucketMapFromSingle(value: string | undefined) {
  return value ? `${value}:${value}` : undefined;
}

export function numberFromValue(name: string, value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Invalid numeric value for ${name}: ${value}`);
  return parsed;
}

export function booleanFromValue(value: string | boolean | undefined) {
  if (typeof value === "boolean") return value;
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function itemsFromPaginatedResponse(response: unknown) {
  if (Array.isArray(response)) return response;
  const responseRecord = asRecord(response);
  for (const key of ["result", "images", "videos"] as const) {
    const value = responseRecord[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function resultInfo(response: unknown) {
  if (Array.isArray(response)) return asRecord((response as unknown[] & { result_info?: unknown }).result_info);
  return asRecord(asRecord(response).result_info);
}

export function requestLabel(method: string | undefined, target: string) {
  return `${method ?? "GET"} ${target}`;
}

export function safeName(value: string) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 180);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isAlreadyExists(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return errorStatus(error) === 409 || message.includes("already exists") || message.includes("duplicate");
}

export function isServiceLimit(error: unknown) {
  const message = errorMessage(error).toLowerCase();
  return message.includes("service limit") || message.includes("reached a service limit");
}

export function errorStatus(error: unknown) {
  return error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

export function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

export function log(message: string) {
  process.stdout.write(`${message}\n`);
}

export function logError(message: string) {
  process.stderr.write(`${message}\n`);
}

export function omitUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

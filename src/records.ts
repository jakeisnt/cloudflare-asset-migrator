import type { Manifest, ManifestError, Product } from "./types";

export function failedManifestKeys<T extends Record<K, string>, K extends keyof T>(
  records: T[],
  manifest: Manifest,
  product: Product,
  recordKey: K,
  errorKey: Extract<keyof ManifestError, "id" | "uid" | "key">,
) {
  const keys = new Set<string>();
  for (const record of records) if ("error" in record && record.error) keys.add(record[recordKey]);
  for (const error of manifest.errors) {
    const value = error.product === product ? error[errorKey] : undefined;
    if (value) keys.add(value);
  }
  return keys;
}

export function removeManifestFailures<T extends Record<K, string> & { error?: string }, K extends keyof T>(
  records: T[],
  manifest: Manifest,
  product: Product,
  recordKey: K,
  key: string,
  errorKey: Extract<keyof ManifestError, "id" | "uid" | "key">,
) {
  manifest.errors = manifest.errors.filter((error) => error.product !== product || error[errorKey] !== key);
  return records.filter((record) => record[recordKey] !== key || !record.error);
}

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ApiContext } from "./api";
import type { Config } from "./config";
import type { Manifest, Product } from "./types";

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    fromAccountId: "from-account",
    fromToken: "from-token",
    toAccountId: "to-account",
    toToken: "to-token",
    dumpDir: "",
    products: new Set<Product>(["images", "stream"]),
    kvNamespaceMap: [],
    r2BucketMap: [],
    streamDownloadReadyTimeoutMs: 1_000,
    streamPollMs: 1,
    streamTransferTimeoutMs: 1_000,
    transferTimeoutMs: 1_000,
    maxRetries: 1,
    retryBaseMs: 1,
    retryMaxMs: 1,
    requestTimeoutMs: 1_000,
    dryRun: false,
    ...overrides,
  };
}

export function testManifest(config: Config): Manifest {
  return {
    startedAt: "2026-01-01T00:00:00.000Z",
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

export async function withTempContext<T>(overrides: Partial<Config>, run: (context: ApiContext, manifest: Manifest) => Promise<T>) {
  const dumpDir = await mkdtemp(path.join(os.tmpdir(), "cf-migrator-test-"));
  const config = testConfig({ dumpDir, ...overrides });
  const context: ApiContext = { config };
  const manifest = testManifest(config);
  try {
    return await run(context, manifest);
  } finally {
    await rm(dumpDir, { recursive: true, force: true });
  }
}

export type FetchCall = { url: string; init: RequestInit | undefined };

export function jsonResponse(result: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify({ success: true, result }), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

export function installFetchMock(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

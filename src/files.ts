import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { ApiContext } from "./api";
import { retry } from "./api";
import type { ResponseData } from "./types";

export async function saveResponseWithRetries(
  context: ApiContext,
  label: string,
  fetchResponse: () => Promise<Response>,
  outPath: string,
  timeoutMs = context.config.transferTimeoutMs,
) {
  return retry(context, label, async () => {
    const response = await fetchResponse();
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const bytesWritten = await saveResponseBody(response, outPath, { label, timeoutMs });
    return { contentType, bytesWritten };
  });
}

export async function responseBytesWithRetries(
  context: ApiContext,
  label: string,
  fetchResponse: () => Promise<Response>,
): Promise<ResponseData> {
  return retry(context, label, async () => {
    const response = await fetchResponse();
    return {
      bytes: await response.bytes(),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
    };
  });
}

export async function saveResponseBody(
  response: Response,
  outPath: string,
  options: { label?: string; timeoutMs?: number } = {},
) {
  if (!response.body) throw new Error("response had no body");
  await mkdir(path.dirname(outPath), { recursive: true });
  const tempPath = `${outPath}.part-${process.pid}-${Date.now()}`;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const label = options.label ?? outPath;
  const reader = response.body.getReader();
  const writer = createWriteStream(tempPath);
  let bytesWritten = 0;
  let timeout: Timer | undefined;
  let timedOut = false;

  const clearBodyTimeout = () => {
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
  };
  const resetBodyTimeout = () => {
    clearBodyTimeout();
    timeout = setTimeout(() => {
      timedOut = true;
      const error = new Error(`${label}: response body stalled after ${timeoutMs}ms (${bytesWritten} bytes written)`);
      void reader.cancel(error).catch(() => undefined);
      writer.destroy(error);
    }, timeoutMs);
  };

  try {
    while (true) {
      resetBodyTimeout();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytesWritten += value.byteLength;
      if (!writer.write(value)) await once(writer, "drain");
    }
    clearBodyTimeout();
    writer.end();
    await once(writer, "finish");
    if (timedOut) throw new Error(`${label}: response body timed out after ${timeoutMs}ms`);
    await rename(tempPath, outPath);
    return bytesWritten;
  } catch (error) {
    clearBodyTimeout();
    writer.destroy();
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function writeBytes(outPath: string, bytes: Uint8Array) {
  await mkdir(path.dirname(outPath), { recursive: true });
  await Bun.write(outPath, bytes);
}

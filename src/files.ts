import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ApiContext } from "./api";
import { retry } from "./api";
import type { ResponseData } from "./types";

export async function saveResponseWithRetries(
  context: ApiContext,
  label: string,
  fetchResponse: () => Promise<Response>,
  outPath: string,
) {
  return retry(context, label, async () => {
    const response = await fetchResponse();
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    await saveResponseBody(response, outPath);
    return { contentType };
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

export async function saveResponseBody(response: Response, outPath: string) {
  if (!response.body) throw new Error("response had no body");
  await mkdir(path.dirname(outPath), { recursive: true });
  await Bun.write(outPath, response);
}

export async function writeBytes(outPath: string, bytes: Uint8Array) {
  await mkdir(path.dirname(outPath), { recursive: true });
  await Bun.write(outPath, bytes);
}

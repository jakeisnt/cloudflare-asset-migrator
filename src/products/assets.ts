import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ApiContext } from "../api";
import { cfFetch, cfJson, httpFetch, listPaginated, parseCloudflareJson, retry } from "../api";
import { responseBytesWithRetries, saveResponseWithRetries, writeBytes } from "../files";
import { writeManifest } from "../manifest";
import { createR2TemporaryCredentials, r2Fetch, r2ListObjects } from "../r2";
import type { ImageItem, ImageRecord, KvKeyInfo, KvNamespace, Manifest, StreamItem, StreamRecord } from "../types";
import {
  arrayValue,
  asRecord,
  errorMessage,
  errorStatus,
  isAlreadyExists,
  isServiceLimit,
  log,
  logError,
  resultInfo,
  safeName,
  stringValue,
} from "../utils";

export async function migrateImages(context: ApiContext, manifest: Manifest) {
  log("Listing Cloudflare Images...");
  const images = await listPaginated((page, perPage) =>
    cfJson(context, "from", `/accounts/${context.config.fromAccountId}/images/v1?page=${page}&per_page=${perPage}`),
  );
  log(`Found ${images.length} image(s).`);
  const retryFailedImageIds = context.config.retryFailedProducts.has("images") ? failedImageIds(manifest) : null;
  if (retryFailedImageIds) log(`Images: retrying ${retryFailedImageIds.size} failed image(s) from manifest.`);

  for (const rawImage of images) {
    const image = rawImage as ImageItem;
    const id = stringValue(image.id) ?? "";
    if (!id) continue;
    if (retryFailedImageIds && !retryFailedImageIds.has(id)) continue;
    const filename = safeName(stringValue(image.filename) ?? id);
    const outPath = path.join(context.config.dumpDir, "images", `${safeName(id)}-${filename}`);
    const record = {
      id,
      filename: stringValue(image.filename) ?? null,
      localPath: outPath,
      uploadedId: null,
      skipped: false,
    };

    try {
      let contentType = "application/octet-stream";
      if (fileExistsWithContent(outPath)) {
        log(`Image ${id}: using existing local dump.`);
      } else {
        log(`Image ${id}: downloading...`);
        const blob = await saveResponseWithRetries(
          context,
          `Image ${id} download`,
          () =>
            cfFetch(
              context,
              "from",
              `/accounts/${context.config.fromAccountId}/images/v1/${encodeURIComponent(id)}/blob`,
            ),
          outPath,
          context.config.transferTimeoutMs,
        );
        contentType = blob.contentType;
        log(`Image ${id}: saved local dump (${blob.bytesWritten} bytes).`);
      }

      if (context.config.dryRun) {
        log(`Image ${id}: dry-run, not uploading.`);
        record.skipped = true;
      } else {
        log(`Image ${id}: uploading...`);
        const form = new FormData();
        const bytes = await Bun.file(outPath).bytes();
        form.set("file", new Blob([bytes], { type: contentType }), stringValue(image.filename) ?? filename);
        form.set("id", id);
        form.set("metadata", JSON.stringify(imageMigrationMetadata(context, id, image)));
        if (typeof image.requireSignedURLs === "boolean")
          form.set("requireSignedURLs", String(image.requireSignedURLs));
        const upload = asRecord(
          await cfJson(context, "to", `/accounts/${context.config.toAccountId}/images/v1`, {
            method: "POST",
            body: form,
          }),
        );
        record.uploadedId = stringValue(upload.id) ?? stringValue(asRecord(upload.result).id) ?? id;
        log(`Image ${id}: uploaded as ${record.uploadedId}.`);
      }
    } catch (error) {
      if (isAlreadyExists(error)) {
        log(`Image ${id}: already exists on target; keeping existing ID.`);
        record.uploadedId = id;
        record.skipped = true;
      } else {
        record.error = errorMessage(error);
        removeImageFailures(manifest, id);
        manifest.errors.push({ product: "images", id, error: record.error });
        logError(`Image ${id}: ${record.error}`);
        manifest.images.push(record);
        await writeManifest(context.config, manifest);
        if (isAssetPipelineBlocker(error)) {
          logError(`Images: stopping image pipeline after non-retryable Cloudflare Images failure on ${id}.`);
          break;
        }
        log(`Image ${id}: skipping after failure; continuing with next image.`);
        continue;
      }
    }

    removeImageFailures(manifest, id);
    manifest.images.push(record);
    await writeManifest(context.config, manifest);
  }
}

function imageMigrationMetadata(context: ApiContext, id: string, image: ImageItem) {
  const originalMetadata = asRecord(image.metadata);
  return {
    ...originalMetadata,
    migratedFromImageId: id,
    migratedFromAccountId: context.config.fromAccountId,
    migratedToAccountId: context.config.toAccountId,
    migratedBy: "cloudflare-asset-migrator",
    migratedAt: new Date().toISOString(),
    sourceAsset: {
      product: "cloudflare-images",
      accountId: context.config.fromAccountId,
      id,
      filename: stringValue(image.filename),
      metadata: originalMetadata,
      requireSignedURLs: typeof image.requireSignedURLs === "boolean" ? image.requireSignedURLs : undefined,
    },
  };
}

function failedImageIds(manifest: Manifest) {
  const ids = new Set<string>();
  for (const record of manifest.images) if (record.error) ids.add(record.id);
  for (const error of manifest.errors) if (error.product === "images" && error.id) ids.add(error.id);
  return ids;
}

function removeImageFailures(manifest: Manifest, id: string) {
  manifest.images = manifest.images.filter((record) => record.id !== id || !record.error);
  manifest.errors = manifest.errors.filter((error) => error.product !== "images" || error.id !== id);
}

function isAssetPipelineBlocker(error: unknown) {
  const status = errorStatus(error);
  return status === 401 || status === 403 || status === 404 || status === 429 || isServiceLimit(error);
}

function fileExistsWithContent(filePath: string) {
  try {
    return existsSync(filePath) && statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

export async function migrateStream(context: ApiContext, manifest: Manifest) {
  log("Listing Cloudflare Stream videos...");
  const videos = await listPaginated((page, perPage) =>
    cfJson(
      context,
      "from",
      `/accounts/${context.config.fromAccountId}/stream?page=${page}&per_page=${perPage}&include_counts=true`,
    ),
  );
  log(`Found ${videos.length} Stream video(s).`);
  const retryFailedStreamUids = context.config.retryFailedProducts.has("stream") ? failedStreamUids(manifest) : null;
  if (retryFailedStreamUids) log(`Stream: retrying ${retryFailedStreamUids.size} failed video(s) from manifest.`);

  const previousStreamRecords = [...(await readPreviousStreamRecords(context)), ...manifest.stream];
  const targetVideosBySourceUid = context.config.dryRun
    ? new Map<string, string>()
    : await targetStreamVideosBySourceUid(context);
  const uploadedBySourceUid = new Map<string, string>();
  for (const record of previousStreamRecords) {
    if (record.uid && record.uploadedUid) uploadedBySourceUid.set(record.uid, record.uploadedUid);
  }
  for (const [sourceUid, targetUid] of targetVideosBySourceUid) uploadedBySourceUid.set(sourceUid, targetUid);

  for (const rawVideo of videos) {
    const video = rawVideo as StreamItem;
    const uid = stringValue(video.uid) ?? "";
    if (!uid) continue;
    if (retryFailedStreamUids && !retryFailedStreamUids.has(uid)) continue;
    const name = stringValue(video.meta?.name) ?? stringValue(video.meta?.filename) ?? uid;
    const outPath = path.join(context.config.dumpDir, "stream", `${safeName(uid)}-${safeName(name)}.mp4`);
    const record = { uid, name, localPath: outPath, downloadUrl: null, uploadedUid: null, size: 0, skipped: false };

    try {
      const migratedFromStreamUid = stringValue(video.meta?.migratedFromStreamUid);
      if (migratedFromStreamUid) {
        log(`Stream ${uid}: skipping target-side migrated copy of source Stream ${migratedFromStreamUid}.`);
        record.uploadedUid = uid;
        record.skipped = true;
        removeStreamFailures(manifest, uid);
        manifest.stream.push(record);
        await writeManifest(context.config, manifest);
        continue;
      }

      const existingUploadedUid = uploadedBySourceUid.get(uid);
      if (existingUploadedUid) {
        log(`Stream ${uid}: already migrated to target Stream as ${existingUploadedUid}; skipping upload.`);
        record.uploadedUid = existingUploadedUid;
        record.skipped = true;
        if (fileExistsWithContent(outPath)) record.size = statSync(outPath).size;
        removeStreamFailures(manifest, uid);
        manifest.stream.push(record);
        await writeManifest(context.config, manifest);
        continue;
      }

      if (fileExistsWithContent(outPath)) {
        record.size = statSync(outPath).size;
        log(`Stream ${uid}: using existing local MP4 dump (${record.size} bytes).`);
      } else {
        const downloadUrl = await ensureStreamDownloadUrl(context, uid);
        record.downloadUrl = downloadUrl;
        log(`Stream ${uid}: downloading MP4 backup...`);
        await saveResponseWithRetries(
          context,
          `Stream ${uid} MP4 download`,
          () => httpFetch(context, downloadUrl, { timeoutMs: context.config.streamTransferTimeoutMs }),
          outPath,
          context.config.streamTransferTimeoutMs,
        );
        record.size = statSync(outPath).size;
        log(`Stream ${uid}: saved MP4 backup (${record.size} bytes).`);
      }
      if (context.config.dryRun) {
        log(`Stream ${uid}: dry-run, not uploading.`);
        record.skipped = true;
      } else {
        log(`Stream ${uid}: uploading MP4 backup to target Stream...`);
        const uploaded = asRecord(await uploadStreamFromFile(context, uid, outPath, name, video));
        record.uploadedUid = stringValue(uploaded.uid) ?? stringValue(asRecord(uploaded.result).uid) ?? null;
        if (record.uploadedUid) uploadedBySourceUid.set(uid, record.uploadedUid);
        log(`Stream ${uid}: uploaded as ${record.uploadedUid ?? "unknown uid"}.`);
      }
    } catch (error) {
      record.error = errorMessage(error);
      removeStreamFailures(manifest, uid);
      manifest.errors.push({ product: "stream", uid, error: record.error });
      logError(`Stream ${uid}: ${record.error}`);
      manifest.stream.push(record);
      await writeManifest(context.config, manifest);
      if (isAssetPipelineBlocker(error)) {
        logError(`Stream: stopping video pipeline after non-retryable Cloudflare Stream failure on ${uid}.`);
        break;
      }
      log(`Stream ${uid}: skipping after failure; continuing with next video.`);
      continue;
    }
    removeStreamFailures(manifest, uid);
    manifest.stream.push(record);
    await writeManifest(context.config, manifest);
  }
}

function failedStreamUids(manifest: Manifest) {
  const uids = new Set<string>();
  for (const record of manifest.stream) if (record.error) uids.add(record.uid);
  for (const error of manifest.errors) if (error.product === "stream" && error.uid) uids.add(error.uid);
  return uids;
}

function removeStreamFailures(manifest: Manifest, uid: string) {
  manifest.stream = manifest.stream.filter((record) => record.uid !== uid || !record.error);
  manifest.errors = manifest.errors.filter((error) => error.product !== "stream" || error.uid !== uid);
}

async function readPreviousStreamRecords(context: ApiContext): Promise<StreamRecord[]> {
  const manifestPath = path.join(context.config.dumpDir, "manifest.json");
  if (!existsSync(manifestPath)) return [];
  try {
    const parsed = JSON.parse(await Bun.file(manifestPath).text()) as unknown;
    const stream = asRecord(parsed).stream;
    if (!Array.isArray(stream)) return [];
    return stream.flatMap((entry) => {
      const record = asRecord(entry);
      const uid = stringValue(record.uid);
      const name = stringValue(record.name);
      const localPath = stringValue(record.localPath);
      if (!uid || !name || !localPath) return [];
      return [
        {
          uid,
          name,
          localPath,
          downloadUrl: stringValue(record.downloadUrl) ?? null,
          uploadedUid: stringValue(record.uploadedUid) ?? null,
          size: typeof record.size === "number" ? record.size : undefined,
          skipped: typeof record.skipped === "boolean" ? record.skipped : undefined,
          error: stringValue(record.error),
        },
      ];
    });
  } catch (error) {
    logError(`Stream: could not read previous manifest for idempotency (${errorMessage(error)}); continuing.`);
    return [];
  }
}

async function targetStreamVideosBySourceUid(context: ApiContext) {
  log("Listing target Cloudflare Stream videos for idempotency checks...");
  const videos = await listPaginated((page, perPage) =>
    cfJson(
      context,
      "to",
      `/accounts/${context.config.toAccountId}/stream?page=${page}&per_page=${perPage}&include_counts=true`,
    ),
  );
  const uploadedBySourceUid = new Map<string, string>();
  for (const rawVideo of videos) {
    const video = rawVideo as StreamItem;
    const targetUid = stringValue(video.uid);
    const sourceUid = stringValue(video.meta?.migratedFromStreamUid);
    if (targetUid && sourceUid && !uploadedBySourceUid.has(sourceUid)) uploadedBySourceUid.set(sourceUid, targetUid);
  }
  log(`Found ${uploadedBySourceUid.size} target Stream video(s) with migrator source metadata.`);
  return uploadedBySourceUid;
}

async function ensureStreamDownloadUrl(context: ApiContext, uid: string): Promise<string> {
  await cfJson(
    context,
    "from",
    `/accounts/${context.config.fromAccountId}/stream/${encodeURIComponent(uid)}/downloads`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    },
  ).catch((error: unknown) => {
    if (!isAlreadyExists(error)) throw error;
  });
  const started = Date.now();
  while (Date.now() - started < context.config.streamDownloadReadyTimeoutMs) {
    const result = await cfJson(
      context,
      "from",
      `/accounts/${context.config.fromAccountId}/stream/${encodeURIComponent(uid)}/downloads`,
    );
    const resultRecord = asRecord(result);
    const candidate =
      resultRecord.default ?? asRecord(resultRecord.downloads).default ?? arrayValue(result)[0] ?? result;
    const candidateRecord = asRecord(candidate);
    const status =
      stringValue(asRecord(candidateRecord.status).state) ??
      stringValue(candidateRecord.status) ??
      stringValue(asRecord(resultRecord.status).state) ??
      stringValue(resultRecord.status);
    const url = stringValue(candidateRecord.url);
    if (url && status?.toLowerCase() !== "inprogress") return url;
    log(`Stream ${uid}: download status ${status ?? "pending"}; waiting...`);
    await Bun.sleep(context.config.streamPollMs);
  }
  throw new Error(`timed out waiting for Stream download after ${context.config.streamDownloadReadyTimeoutMs}ms`);
}

function streamMigrationMeta(context: ApiContext, uid: string, name: string, video: StreamItem) {
  return {
    ...(video.meta ?? { name }),
    name,
    migratedFromStreamUid: uid,
    migratedFromAccountId: context.config.fromAccountId,
    migratedToAccountId: context.config.toAccountId,
    migratedBy: "cloudflare-asset-migrator",
    migratedAt: new Date().toISOString(),
    sourceAsset: {
      product: "cloudflare-stream",
      accountId: context.config.fromAccountId,
      uid,
      name,
      meta: video.meta ?? {},
      requireSignedURLs: typeof video.requireSignedURLs === "boolean" ? video.requireSignedURLs : undefined,
      allowedOrigins: Array.isArray(video.allowedOrigins) ? video.allowedOrigins : undefined,
      thumbnailTimestampPct: typeof video.thumbnailTimestampPct === "number" ? video.thumbnailTimestampPct : undefined,
    },
  };
}

async function uploadStreamFromFile(
  context: ApiContext,
  uid: string,
  filePath: string,
  name: string,
  video: StreamItem,
) {
  return retry(context, `Stream ${uid} upload`, async () => {
    const form = new FormData();
    form.set("file", Bun.file(filePath), `${safeName(name)}.mp4`);
    form.set("meta", JSON.stringify(streamMigrationMeta(context, uid, name, video)));
    form.set("requireSignedURLs", String(Boolean(video.requireSignedURLs)));
    if (Array.isArray(video.allowedOrigins)) form.set("allowedOrigins", JSON.stringify(video.allowedOrigins));
    if (typeof video.thumbnailTimestampPct === "number")
      form.set("thumbnailTimestampPct", String(video.thumbnailTimestampPct));

    const endpoint = `/accounts/${context.config.toAccountId}/stream`;
    const response = await cfFetch(context, "to", endpoint, {
      method: "POST",
      body: form,
      noRetry: true,
      timeoutMs: context.config.streamTransferTimeoutMs,
    });
    return parseCloudflareJson(context, "to", endpoint, "POST", response);
  });
}

async function assetReferenceReplacementsForKv(context: ApiContext, manifest: Manifest) {
  const previousManifest = await readPreviousManifest(context);
  const replacements = new Map<string, string>();
  addRecordReplacements(replacements, [
    ...streamReferenceRecords(asRecord(previousManifest).stream),
    ...manifest.stream,
  ]);
  addRecordReplacements(replacements, [
    ...imageReferenceRecords(asRecord(previousManifest).images),
    ...manifest.images,
  ]);

  if (context.config.fromStreamCustomerCode && context.config.toStreamCustomerCode) {
    replacements.set(context.config.fromStreamCustomerCode, context.config.toStreamCustomerCode);
    replacements.set(
      `customer-${context.config.fromStreamCustomerCode}.cloudflarestream.com`,
      `customer-${context.config.toStreamCustomerCode}.cloudflarestream.com`,
    );
  }
  if (context.config.fromImagesAccountHash && context.config.toImagesAccountHash) {
    replacements.set(context.config.fromImagesAccountHash, context.config.toImagesAccountHash);
    replacements.set(
      `imagedelivery.net/${context.config.fromImagesAccountHash}`,
      `imagedelivery.net/${context.config.toImagesAccountHash}`,
    );
  }

  const sortedReplacements = [...replacements]
    .filter(([from, to]) => from !== to)
    .sort(([left], [right]) => right.length - left.length);
  log(`KV: prepared ${sortedReplacements.length} asset reference replacement(s).`);
  return sortedReplacements;
}

async function readPreviousManifest(context: ApiContext) {
  const manifestPath = path.join(context.config.dumpDir, "manifest.json");
  if (!existsSync(manifestPath)) return {};
  try {
    return JSON.parse(await Bun.file(manifestPath).text()) as unknown;
  } catch (error) {
    logError(
      `KV: could not read previous manifest for asset reference rewriting (${errorMessage(error)}); continuing.`,
    );
    return {};
  }
}

function streamReferenceRecords(value: unknown): StreamRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const uid = stringValue(record.uid);
    const uploadedUid = stringValue(record.uploadedUid);
    if (!uid || !uploadedUid) return [];
    return [
      {
        uid,
        name: stringValue(record.name) ?? uid,
        localPath: stringValue(record.localPath) ?? "",
        downloadUrl: null,
        uploadedUid,
      },
    ];
  });
}

function imageReferenceRecords(value: unknown): ImageRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const id = stringValue(record.id);
    const uploadedId = stringValue(record.uploadedId);
    if (!id || !uploadedId) return [];
    return [
      {
        id,
        filename: stringValue(record.filename) ?? null,
        localPath: stringValue(record.localPath) ?? "",
        uploadedId,
        skipped: Boolean(record.skipped),
      },
    ];
  });
}

function addRecordReplacements(replacements: Map<string, string>, records: Array<StreamRecord | ImageRecord>) {
  for (const record of records) {
    if ("uid" in record && record.uploadedUid) replacements.set(record.uid, record.uploadedUid);
    if ("id" in record && record.uploadedId) replacements.set(record.id, record.uploadedId);
  }
}

function rewriteKvAssetReferences(bytes: Uint8Array, replacements: Array<[string, string]>) {
  if (replacements.length === 0) return { bytes, replacementCount: 0 };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { bytes, replacementCount: 0 };
  }

  let replacementCount = 0;
  let rewritten = text;
  for (const [from, to] of replacements) {
    const count = rewritten.split(from).length - 1;
    if (count === 0) continue;
    replacementCount += count;
    rewritten = rewritten.replaceAll(from, to);
  }
  if (replacementCount === 0) return { bytes, replacementCount };
  return { bytes: new TextEncoder().encode(rewritten), replacementCount };
}

export async function migrateKv(context: ApiContext, manifest: Manifest) {
  if (context.config.kvNamespaceMap.length === 0)
    throw new Error("CF_MIGRATE includes kv but CF_KV_NAMESPACE_MAP is empty.");
  const assetReferenceReplacements = await assetReferenceReplacementsForKv(context, manifest);
  for (const [fromNamespaceRef, toNamespaceRef] of context.config.kvNamespaceMap) {
    const fromNamespaceId = await resolveKvNamespace(context, "from", fromNamespaceRef);
    const toNamespaceId = await resolveKvNamespace(context, "to", toNamespaceRef);
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "1000" });
      if (cursor) query.set("cursor", cursor);
      const page = await cfJson(
        context,
        "from",
        `/accounts/${context.config.fromAccountId}/storage/kv/namespaces/${fromNamespaceId}/keys?${query}`,
      );
      for (const rawKeyInfo of arrayValue(page)) {
        const key = stringValue((rawKeyInfo as KvKeyInfo).name);
        if (!key) continue;
        const localPath = path.join(context.config.dumpDir, "kv", `${safeName(fromNamespaceId)}-${safeName(key)}.bin`);
        const value = await responseBytesWithRetries(context, `KV ${fromNamespaceId}/${key} download`, () =>
          cfFetch(
            context,
            "from",
            `/accounts/${context.config.fromAccountId}/storage/kv/namespaces/${fromNamespaceId}/values/${encodeURIComponent(key)}`,
          ),
        );
        await writeBytes(localPath, value.bytes);
        const rewrittenValue = rewriteKvAssetReferences(value.bytes, assetReferenceReplacements);
        if (rewrittenValue.replacementCount > 0) {
          log(`KV ${fromNamespaceId}/${key}: rewrote ${rewrittenValue.replacementCount} asset reference(s).`);
        }
        if (!context.config.dryRun) {
          await cfFetch(
            context,
            "to",
            `/accounts/${context.config.toAccountId}/storage/kv/namespaces/${toNamespaceId}/values/${encodeURIComponent(key)}`,
            {
              method: "PUT",
              headers: { "content-type": value.contentType },
              body: rewrittenValue.bytes,
            },
          );
        }
        manifest.kv.push({ fromNamespaceId, toNamespaceId, key, localPath });
      }
      cursor = stringValue(resultInfo(page).cursor);
      await writeManifest(context.config, manifest);
    } while (cursor);
  }
}

async function resolveKvNamespace(context: ApiContext, side: "from" | "to", namespaceRef: string) {
  if (/^[a-f0-9]{32}$/i.test(namespaceRef)) return namespaceRef;
  const accountId = side === "from" ? context.config.fromAccountId : context.config.toAccountId;
  const namespaces = await listPaginated((page, perPage) =>
    cfJson(context, side, `/accounts/${accountId}/storage/kv/namespaces?page=${page}&per_page=${perPage}`),
  );
  const match = namespaces.find((namespace) => {
    const item = namespace as KvNamespace;
    return item.title === namespaceRef || item.id === namespaceRef;
  }) as KvNamespace | undefined;
  const id = stringValue(match?.id);
  if (!id) throw new Error(`Could not resolve KV namespace ${namespaceRef} in ${side} account`);
  return id;
}

export async function migrateR2(context: ApiContext, manifest: Manifest) {
  if (context.config.r2BucketMap.length === 0)
    throw new Error("CF_MIGRATE includes r2 but CF_R2_BUCKET_MAP or CF_R2_BUCKET is empty.");
  for (const [fromBucket, toBucket] of context.config.r2BucketMap) {
    const fromCredentials = await createR2TemporaryCredentials(context, "from", fromBucket, "object-read-only");
    const toCredentials = await createR2TemporaryCredentials(context, "to", toBucket, "object-read-write");
    let continuationToken: string | undefined;
    do {
      const page = await r2ListObjects(context, "from", fromBucket, fromCredentials, continuationToken);
      for (const object of page.objects) {
        const localPath = path.join(
          context.config.dumpDir,
          "r2",
          safeName(fromBucket),
          ...object.key.split("/").map(safeName),
        );
        const response = await responseBytesWithRetries(context, `R2 ${fromBucket}/${object.key} download`, () =>
          r2Fetch(context, "from", "GET", fromBucket, object.key, fromCredentials),
        );
        await writeBytes(localPath, response.bytes);
        if (!context.config.dryRun)
          await r2Fetch(context, "to", "PUT", toBucket, object.key, toCredentials, {
            body: response.bytes,
            contentType: response.contentType,
          });
        manifest.r2.push({ fromBucket, toBucket, key: object.key, localPath, size: response.bytes.byteLength });
        await writeManifest(context.config, manifest);
      }
      continuationToken = page.nextContinuationToken;
    } while (continuationToken);
  }
}

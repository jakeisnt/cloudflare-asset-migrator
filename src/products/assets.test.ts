import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { type FetchCall, installFetchMock, jsonResponse, withTempContext } from "../test-helpers";
import { migrateImages, migrateKv, migrateStream } from "./assets";

let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function endpoint(url: string) {
  return new URL(url).pathname + new URL(url).search;
}

function method(call: FetchCall) {
  return call.init?.method ?? "GET";
}

describe("migrateImages", () => {
  test("downloads each source image and uploads it with Cloudflare Images metadata", async () => {
    await withTempContext({}, async (context, manifest) => {
      const mock = installFetchMock((url, init) => {
        const path = endpoint(url);
        if (path === "/client/v4/accounts/from-account/images/v1?page=1&per_page=100") {
          return jsonResponse([
            {
              id: "image-1",
              filename: "Hero Image.jpg",
              metadata: { alt: "Hero" },
              requireSignedURLs: true,
            },
          ]);
        }
        if (path === "/client/v4/accounts/from-account/images/v1/image-1/blob") {
          return new Response("image-bytes", { headers: { "content-type": "image/jpeg" } });
        }
        if (path === "/client/v4/accounts/to-account/images/v1" && init?.method === "POST") {
          const form = init.body as FormData;
          expect(form.get("id")).toBe("image-1");
          const metadata = JSON.parse(String(form.get("metadata"))) as Record<string, unknown>;
          expect(metadata.alt).toBe("Hero");
          expect(metadata.migratedFromImageId).toBe("image-1");
          expect(metadata.migratedFromAccountId).toBe("from-account");
          expect((metadata.sourceAsset as Record<string, unknown>).product).toBe("cloudflare-images");
          expect(form.get("requireSignedURLs")).toBe("true");
          expect(form.get("file")).toBeInstanceOf(File);
          return jsonResponse({ id: "uploaded-image-1" });
        }
        throw new Error(`Unexpected request: ${method({ url, init })} ${path}`);
      });
      restoreFetch = mock.restore;

      await migrateImages(context, manifest);

      expect(manifest.images).toEqual([
        expect.objectContaining({
          id: "image-1",
          filename: "Hero Image.jpg",
          uploadedId: "uploaded-image-1",
          skipped: false,
        }),
      ]);
      expect(await readFile(manifest.images[0]?.localPath ?? "", "utf8")).toBe("image-bytes");
      expect(mock.calls.map((call) => `${method(call)} ${endpoint(call.url)}`)).toEqual([
        "GET /client/v4/accounts/from-account/images/v1?page=1&per_page=100",
        "GET /client/v4/accounts/from-account/images/v1/image-1/blob",
        "POST /client/v4/accounts/to-account/images/v1",
      ]);
    });
  });

  test("dry-run downloads but does not upload images", async () => {
    await withTempContext({ dryRun: true }, async (context, manifest) => {
      const mock = installFetchMock((url) => {
        const path = endpoint(url);
        if (path.includes("/images/v1?page=")) return jsonResponse([{ id: "dry-image", filename: "dry.png" }]);
        if (path.endsWith("/images/v1/dry-image/blob")) return new Response("dry-bytes");
        throw new Error(`Unexpected request: ${path}`);
      });
      restoreFetch = mock.restore;

      await migrateImages(context, manifest);

      expect(manifest.images).toEqual([expect.objectContaining({ id: "dry-image", uploadedId: null, skipped: true })]);
      expect(mock.calls.some((call) => endpoint(call.url) === "/client/v4/accounts/to-account/images/v1")).toBe(false);
    });
  });

  test("marks a duplicate target image as skipped instead of failing", async () => {
    await withTempContext({}, async (context, manifest) => {
      const mock = installFetchMock((url, init) => {
        const path = endpoint(url);
        if (path.includes("/images/v1?page=")) return jsonResponse([{ id: "existing-image", filename: "exists.jpg" }]);
        if (path.endsWith("/images/v1/existing-image/blob")) return new Response("bytes");
        if (path === "/client/v4/accounts/to-account/images/v1" && init?.method === "POST") {
          return new Response(JSON.stringify({ success: false, errors: [{ message: "already exists" }] }), {
            status: 409,
            statusText: "Conflict",
          });
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      restoreFetch = mock.restore;

      await migrateImages(context, manifest);

      expect(manifest.errors).toEqual([]);
      expect(manifest.images).toEqual([
        expect.objectContaining({ id: "existing-image", uploadedId: "existing-image", skipped: true }),
      ]);
    });
  });
});

describe("migrateStream", () => {
  test("downloads a Stream MP4 backup and uploads it with migration metadata", async () => {
    await withTempContext({}, async (context, manifest) => {
      const mock = installFetchMock((url, init) => {
        const path = endpoint(url);
        if (path === "/client/v4/accounts/from-account/stream?page=1&per_page=100&include_counts=true") {
          return jsonResponse([{ uid: "video-1", meta: { name: "Launch Film" }, requireSignedURLs: true }]);
        }
        if (path === "/client/v4/accounts/to-account/stream?page=1&per_page=100&include_counts=true") {
          return jsonResponse([]);
        }
        if (path === "/client/v4/accounts/from-account/stream/video-1/downloads" && init?.method === "POST") {
          return jsonResponse({ ok: true });
        }
        if (path === "/client/v4/accounts/from-account/stream/video-1/downloads") {
          return jsonResponse({
            default: { status: { state: "ready" }, url: "https://downloads.example/video-1.mp4" },
          });
        }
        if (url === "https://downloads.example/video-1.mp4") return new Response("mp4-bytes");
        if (path === "/client/v4/accounts/to-account/stream" && init?.method === "POST") {
          const form = init.body as FormData;
          const meta = JSON.parse(String(form.get("meta"))) as Record<string, unknown>;
          expect(meta.name).toBe("Launch Film");
          expect(meta.migratedFromStreamUid).toBe("video-1");
          expect(form.get("requireSignedURLs")).toBe("true");
          expect(form.get("file")).toBeInstanceOf(File);
          return jsonResponse({ uid: "uploaded-video-1" });
        }
        throw new Error(`Unexpected request: ${method({ url, init })} ${path}`);
      });
      restoreFetch = mock.restore;

      await migrateStream(context, manifest);

      expect(manifest.stream).toEqual([
        expect.objectContaining({
          uid: "video-1",
          name: "Launch Film",
          uploadedUid: "uploaded-video-1",
          skipped: false,
        }),
      ]);
      expect(await readFile(manifest.stream[0]?.localPath ?? "", "utf8")).toBe("mp4-bytes");
    });
  });

  test("skips target-side Stream copies that already carry source migration metadata", async () => {
    await withTempContext({ dryRun: true }, async (context, manifest) => {
      const mock = installFetchMock((url) => {
        const path = endpoint(url);
        if (path.includes("/stream?page=")) {
          return jsonResponse([{ uid: "target-copy", meta: { name: "Copy", migratedFromStreamUid: "source-video" } }]);
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      restoreFetch = mock.restore;

      await migrateStream(context, manifest);

      expect(manifest.stream).toEqual([
        expect.objectContaining({ uid: "target-copy", uploadedUid: "target-copy", skipped: true }),
      ]);
      expect(mock.calls).toHaveLength(1);
    });
  });

  test("uses target Stream metadata to avoid uploading an already migrated video", async () => {
    await withTempContext({}, async (context, manifest) => {
      const mock = installFetchMock((url) => {
        const path = endpoint(url);
        if (path === "/client/v4/accounts/from-account/stream?page=1&per_page=100&include_counts=true") {
          return jsonResponse([{ uid: "source-video", meta: { name: "Source" } }]);
        }
        if (path === "/client/v4/accounts/to-account/stream?page=1&per_page=100&include_counts=true") {
          return jsonResponse([{ uid: "target-video", meta: { migratedFromStreamUid: "source-video" } }]);
        }
        throw new Error(`Unexpected request: ${path}`);
      });
      restoreFetch = mock.restore;

      await migrateStream(context, manifest);

      expect(manifest.stream).toEqual([
        expect.objectContaining({ uid: "source-video", uploadedUid: "target-video", skipped: true }),
      ]);
      expect(mock.calls.map((call) => endpoint(call.url))).not.toContain(
        "/client/v4/accounts/from-account/stream/source-video/downloads",
      );
    });
  });
});

describe("migrateKv", () => {
  test("resolves namespace names, downloads keys, rewrites asset references, and writes target values", async () => {
    await withTempContext({ kvNamespaceMap: [["Source KV", "Target KV"]] }, async (context, manifest) => {
      manifest.stream.push({
        uid: "old-video",
        name: "Old video",
        localPath: "stream.mp4",
        downloadUrl: null,
        uploadedUid: "new-video",
      });
      manifest.images.push({
        id: "old-image",
        filename: "old.jpg",
        localPath: "image.jpg",
        uploadedId: "new-image",
        skipped: false,
      });
      const mock = installFetchMock(async (url, init) => {
        const path = endpoint(url);
        if (path === "/client/v4/accounts/from-account/storage/kv/namespaces?page=1&per_page=100") {
          return jsonResponse([{ id: "fromnamespaceid0000000000000000", title: "Source KV" }]);
        }
        if (path === "/client/v4/accounts/to-account/storage/kv/namespaces?page=1&per_page=100") {
          return jsonResponse([{ id: "tonamespaceid000000000000000000", title: "Target KV" }]);
        }
        if (
          path ===
          "/client/v4/accounts/from-account/storage/kv/namespaces/fromnamespaceid0000000000000000/keys?limit=1000"
        ) {
          return jsonResponse([{ name: "site_config" }]);
        }
        if (path.endsWith("/values/site_config") && method({ url, init }) === "GET") {
          return new Response(JSON.stringify({ theme: "flat", filmId: "old-video", imageId: "old-image" }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (path.endsWith("/values/site_config") && method({ url, init }) === "PUT") {
          expect(await new Response(init?.body).text()).toBe(
            JSON.stringify({ theme: "flat", filmId: "new-video", imageId: "new-image" }),
          );
          expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
          return new Response(null, { status: 200 });
        }
        throw new Error(`Unexpected request: ${method({ url, init })} ${path}`);
      });
      restoreFetch = mock.restore;

      await migrateKv(context, manifest);

      expect(manifest.kv).toEqual([
        expect.objectContaining({
          fromNamespaceId: "fromnamespaceid0000000000000000",
          toNamespaceId: "tonamespaceid000000000000000000",
          key: "site_config",
        }),
      ]);
      expect(await readFile(manifest.kv[0]?.localPath ?? "", "utf8")).toBe(
        JSON.stringify({ theme: "flat", filmId: "old-video", imageId: "old-image" }),
      );
    });
  });
});

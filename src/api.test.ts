import { afterEach, describe, expect, test } from "bun:test";
import { cfFetch, cfJson, listPaginated } from "./api";
import { installFetchMock, jsonResponse, testConfig } from "./test-helpers";

let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

describe("Cloudflare API helpers", () => {
  test("listPaginated follows result_info.total_pages", async () => {
    const seenPages: number[] = [];

    const items = await listPaginated(async (page) => {
      seenPages.push(page);
      return {
        result: [`item-${page}`],
        result_info: { total_pages: 3 },
      };
    });

    expect(seenPages).toEqual([1, 2, 3]);
    expect(items).toEqual(["item-1", "item-2", "item-3"]);
  });

  test("cfFetch sends the token for the selected side", async () => {
    const mock = installFetchMock((_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer to-token");
      return jsonResponse({ ok: true });
    });
    restoreFetch = mock.restore;

    const response = await cfFetch({ config: testConfig() }, "to", "/accounts/to-account/images/v1");

    expect(response.ok).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/to-account/images/v1");
  });

  test("cfJson rejects failed Cloudflare envelopes", async () => {
    const mock = installFetchMock(() =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "not authorized" }] }), {
        headers: { "content-type": "application/json" },
      }),
    );
    restoreFetch = mock.restore;

    await expect(cfJson({ config: testConfig() }, "from", "/accounts/from-account/stream")).rejects.toThrow(
      "not authorized",
    );
  });
});

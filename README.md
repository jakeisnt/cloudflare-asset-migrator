# Cloudflare asset migrator (alpha)

Copy Cloudflare account and site resources from one account to another.
Developed when working with a client to move a website and all corresponding hosted data from my cloudflare system to theirs!

Most of this is AI slop - it's the bare minimum that was necessary for me to run a one-time website migration between accounts - but I plan on revisiting it as I continue to collaborate via Cloudlare :  )

`bun` is expected to be used as the runtime. This repo hasn't been tested with anything else.

Copies/dumps:

- Images and Stream
- KV namespaces and R2 buckets when maps are supplied
- Zone config: DNS records, selected zone settings, Page Rules, Rulesets, Workers Routes, and Custom Hostnames

Cloudflare zones cannot be transferred directly. Add the site to the target account, copy/configure resources, verify, then switch registrar nameservers.

## Usage

```sh
CF_FROM_ACCOUNT_ID=... \
CF_FROM_API_TOKEN=... \
CF_TO_ACCOUNT_ID=... \
CF_TO_API_TOKEN=... \
bun run src/index.ts --products images,stream
```

Common commands:

```sh
bun run src/index.ts --help
bun run src/index.ts --dry-run --products dns,zone-settings,page-rules,rulesets
bun run src/index.ts --retry-failed stream
bun run src/index.ts --products kv --kv-namespace-map sourceTitle:targetTitle
bun run src/index.ts --products r2 --r2-bucket-map source-bucket:target-bucket
```

For zone products, also set `CF_FROM_ZONE_ID` and `CF_TO_ZONE_ID` after adding the zone to the target account.

## Environment variables

All environment variables are validated with Zod at startup. Empty strings are rejected, numeric timeout/retry values must be positive numbers, and `CF_MIGRATE_DRY_RUN` must be one of `1`, `0`, `true`, `false`, `yes`, `no`, `on`, or `off`.

| Variable | Required? | How to get it |
| --- | --- | --- |
| `CF_FROM_ACCOUNT_ID` | Yes | Source account dashboard → right sidebar **Account ID**, or `wrangler whoami` for accounts you can access. |
| `CF_TO_ACCOUNT_ID` | Yes | Target account dashboard → right sidebar **Account ID**, or `wrangler whoami`. |
| `CF_FROM_API_TOKEN` | Yes | Cloudflare dashboard → **My Profile** → **API Tokens** → create a token scoped to the source account/zone. Include read permissions for copied products; Stream migration also needs **Stream Edit** because downloads are created with `POST /downloads`. |
| `CF_TO_API_TOKEN` | Yes | Create a token scoped to the target account/zone with edit permissions for products you will write: Images, Stream, KV, R2, DNS, Rulesets, Workers Routes, Custom Hostnames, etc. |
| `CF_FROM_ZONE_ID` | Zone products | Source zone dashboard → right sidebar **Zone ID**. Required for `dns`, `zone-settings`, `page-rules`, `rulesets`, `workers-routes`, and `custom-hostnames`. |
| `CF_TO_ZONE_ID` | Zone products | Add the site to the target account first, then open that target zone dashboard → right sidebar **Zone ID**. |
| `CF_ZONE_NAME` | Optional | The apex domain, e.g. `example.com`; used only for docs/checklists. |
| `CF_ASSET_DUMP_DIR` | Optional | Local output directory for downloaded assets, `manifest.json`, and the cutover checklist. Defaults to `cloudflare-asset-dump`. |
| `CF_MIGRATE` | Optional | Comma-separated products to migrate: `images`, `stream`, `kv`, `r2`, `dns`, `zone-settings`, `page-rules`, `rulesets`, `workers-routes`, `custom-hostnames`. Defaults to `images,stream` unless retrying failed products. |
| `CF_MIGRATE_RETRY_FAILED` | Optional | Comma-separated products whose failed manifest records should be retried, e.g. `stream,images`. |
| `CF_KV_NAMESPACE_MAP` | KV | Comma-separated `sourceNamespaceOrTitle:targetNamespaceOrTitle` pairs. Find names/IDs in dashboard → **Workers & Pages** → **KV**, or via `wrangler kv namespace list`. |
| `CF_R2_BUCKET_MAP` | R2 | Comma-separated `sourceBucket:targetBucket` pairs. Find buckets in dashboard → **R2** or with `wrangler r2 bucket list`; create target buckets first. |
| `CF_R2_BUCKET` | R2 shortcut | Single bucket name when source and target bucket names match. Equivalent to `name:name`. |
| `CF_FROM_R2_PARENT_ACCESS_KEY_ID` | Optional R2 metadata | Source account R2 API token/access key ID if you need to preserve/report the parent access key. Get it from dashboard → **R2** → **Manage R2 API Tokens**. |
| `CF_TO_R2_PARENT_ACCESS_KEY_ID` | Optional R2 metadata | Target account R2 API token/access key ID from dashboard → **R2** → **Manage R2 API Tokens**. |
| `CF_FROM_STREAM_CUSTOMER_CODE` | Optional KV URL rewrites | Source Stream delivery customer subdomain/code from a Stream delivery URL or dashboard Stream settings; use when KV stores full Stream URLs. |
| `CF_TO_STREAM_CUSTOMER_CODE` | Optional KV URL rewrites | Target Stream delivery customer subdomain/code from the target account; use with `CF_FROM_STREAM_CUSTOMER_CODE`. |
| `CF_FROM_IMAGES_ACCOUNT_HASH` | Optional KV URL rewrites | Source Images account hash from an Images delivery URL like `https://imagedelivery.net/<account-hash>/<image-id>/<variant>` or Images dashboard delivery details. |
| `CF_TO_IMAGES_ACCOUNT_HASH` | Optional KV URL rewrites | Target Images account hash from the target account; use with `CF_FROM_IMAGES_ACCOUNT_HASH`. |
| `CF_STREAM_DOWNLOAD_READY_TIMEOUT_MS` | Optional | Milliseconds to wait for a Stream MP4 download to become ready. Defaults to `1200000`. |
| `CF_STREAM_DOWNLOAD_TIMEOUT_MS` | Optional legacy alias | Legacy alias for `CF_STREAM_DOWNLOAD_READY_TIMEOUT_MS`; used only when the newer variable is unset. |
| `CF_STREAM_DOWNLOAD_POLL_MS` | Optional | Milliseconds between Stream download readiness polls. Defaults to `5000`. |
| `CF_STREAM_TRANSFER_TIMEOUT_MS` | Optional | Milliseconds allowed for each Stream transfer. Defaults to `1800000`. |
| `CF_MIGRATE_TRANSFER_TIMEOUT_MS` | Optional | Milliseconds allowed for generic asset transfers. Defaults to `300000`. |
| `CF_MIGRATE_MAX_RETRIES` | Optional | Maximum HTTP retry attempts. Defaults to `8`. |
| `CF_MIGRATE_RETRY_BASE_MS` | Optional | Initial retry backoff in milliseconds. Defaults to `1000`. |
| `CF_MIGRATE_RETRY_MAX_MS` | Optional | Maximum retry backoff in milliseconds. Defaults to `60000`. |
| `CF_MIGRATE_REQUEST_TIMEOUT_MS` | Optional | Per-request timeout in milliseconds. Defaults to `120000`. |
| `CF_MIGRATE_DRY_RUN` | Optional | Set to `1`, `true`, `yes`, or `on` to dump/plan without writing target account. You can also pass `--dry-run`. |

## Notes

- Output goes to `CF_ASSET_DUMP_DIR` (default `cloudflare-asset-dump`) with `manifest.json` and a manual cutover checklist.
- Stream migration needs **Stream Edit** permission on the source token because Cloudflare requires `POST /downloads` to create MP4 backups.
- Stream/Image uploads include source metadata and are idempotent across reruns.
- KV text/JSON values are rewritten to target Stream UIDs and Images IDs. Set customer-code/account-hash env vars if KV stores full delivery URLs.
- The process exits nonzero when any manifest record failed.

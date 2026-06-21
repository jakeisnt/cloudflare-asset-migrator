# Cloudflare site migrator

Copy Cloudflare account and site resources from one account to another.
Developed when working with a client to move a website and all corresponding hosted data from my cloudflare system to theirs!

Most of this is AI slop - it's the bare minimum that was necessary for me to run a one-time website migration between accounts - but I plan on revisiting it as I continue to wokr with external users via Cloudlare.

`bun` is expected to be used. Not tested with other runtimes.

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

## Notes

- Output goes to `CF_ASSET_DUMP_DIR` (default `cloudflare-asset-dump`) with `manifest.json` and a manual cutover checklist.
- Stream migration needs **Stream Edit** permission on the source token because Cloudflare requires `POST /downloads` to create MP4 backups.
- Stream/Image uploads include source metadata and are idempotent across reruns.
- KV text/JSON values are rewritten to target Stream UIDs and Images IDs. Set customer-code/account-hash env vars if KV stores full delivery URLs.
- The process exits nonzero when any manifest record failed.

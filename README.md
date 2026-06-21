# Cloudflare site migrator

Portable Bun/TypeScript migration tool for moving Cloudflare resources between accounts. Cloudflare zones are not directly transferred: add the site to the target account, recreate DNS/config/resources, verify, then change registrar nameservers to the target account's nameservers.

It can copy/dump:

- Images and Stream
- KV namespace contents and R2 buckets when maps are supplied
- Zone-level site config: DNS records, selected zone settings, Page Rules, Rulesets, Workers Routes, and Custom Hostnames

Permission note: Stream migration requires **write/edit permission on the source (`from`) token**, not only read permission, because Cloudflare requires a `POST` to create/download MP4 renditions before the videos can be copied.

Run from this directory:

```sh
CF_FROM_ACCOUNT_ID=... \
CF_FROM_API_TOKEN=... \
CF_TO_ACCOUNT_ID=... \
CF_TO_API_TOKEN=... \
CF_FROM_ZONE_ID=... \
CF_TO_ZONE_ID=... \
bun run src/index.ts --products images,stream,dns,zone-settings,page-rules,rulesets,workers-routes,custom-hostnames
```

Useful flags:

```sh
bun run src/index.ts --help
bun run src/index.ts --dry-run --products dns,zone-settings,page-rules,rulesets
bun run src/index.ts --products kv --kv-namespace-map sourceTitle:targetTitle
bun run src/index.ts --products r2 --r2-bucket-map source-bucket:target-bucket
```

The tool writes `manifest.json` plus a manual cutover checklist into `CF_ASSET_DUMP_DIR` (default: `cloudflare-asset-dump`) and exits nonzero if any migration record failed.

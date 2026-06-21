import path from "node:path";
import type { ApiContext } from "../api";
import { cfJson, listPaginated } from "../api";
import { assertZoneConfig } from "../config";
import { writeManifest } from "../manifest";
import type { Manifest, Product, SiteRecord } from "../types";
import { asRecord, errorMessage, isAlreadyExists, log, logError, omitUndefined, stringValue } from "../utils";

type SiteProduct = Exclude<Product, "images" | "stream" | "kv" | "r2">;

type ZoneSettings = Record<string, unknown>;

export async function migrateSiteProducts(context: ApiContext, manifest: Manifest) {
  const siteProducts: SiteProduct[] = [
    "dns",
    "zone-settings",
    "page-rules",
    "rulesets",
    "workers-routes",
    "custom-hostnames",
  ];
  const selectedSiteProducts = siteProducts.filter((product) => context.config.products.has(product));
  if (selectedSiteProducts.length === 0) return;

  try {
    assertZoneConfig(context.config);
    await writeSiteChecklist(context);
  } catch (error) {
    const message = errorMessage(error);
    for (const product of selectedSiteProducts) manifest.errors.push({ product, error: message });
    logError(`site products: skipped selected site pipelines because zone setup is incomplete: ${message}`);
    return;
  }

  if (context.config.products.has("dns"))
    await runSiteProduct(context, manifest, "dns", () => migrateDnsRecords(context, manifest));
  if (context.config.products.has("zone-settings"))
    await runSiteProduct(context, manifest, "zone-settings", () => migrateZoneSettings(context, manifest));
  if (context.config.products.has("page-rules"))
    await runSiteProduct(context, manifest, "page-rules", () => migratePageRules(context, manifest));
  if (context.config.products.has("rulesets"))
    await runSiteProduct(context, manifest, "rulesets", () => migrateRulesets(context, manifest));
  if (context.config.products.has("workers-routes"))
    await runSiteProduct(context, manifest, "workers-routes", () => migrateWorkersRoutes(context, manifest));
  if (context.config.products.has("custom-hostnames"))
    await runSiteProduct(context, manifest, "custom-hostnames", () => migrateCustomHostnames(context, manifest));
}

async function runSiteProduct(
  context: ApiContext,
  manifest: Manifest,
  product: SiteProduct,
  run: () => Promise<void>,
) {
  try {
    await run();
  } catch (error) {
    const message = errorMessage(error);
    manifest.errors.push({ product, error: message });
    logError(`${product}: stopped this pipeline after error: ${message}`);
    log(`${product}: continuing with remaining selected product pipelines.`);
    await writeManifest(context.config, manifest);
  }
}

async function writeSiteChecklist(context: ApiContext) {
  const file = path.join(context.config.dumpDir, "site", "manual-cutover-checklist.md");
  const zone = context.config.zoneName ?? "the domain";
  await Bun.write(
    file,
    `# Cloudflare site transfer checklist\n\n` +
      `Cloudflare zones are not directly transferred between accounts. Add ${zone} to the target account, recreate zone configuration, then switch nameservers at the registrar after verification.\n\n` +
      `This migrator can copy DNS records, selected zone settings, Page Rules, Rulesets, Workers Routes, and Custom Hostnames. It cannot safely transfer registrar ownership, billing/subscriptions, account memberships, WAF custom rules that reference account resources, Workers scripts, Pages projects, Queues, D1, Durable Objects, Access apps, Turnstile widgets, or third-party origin credentials without separate product-specific work.\n\n` +
      `Before changing nameservers, compare the manifest with the source account, verify orange-cloud/proxy status, SSL/TLS mode, redirects, Worker route behavior, Stream/Images/R2/KV asset references, and origin reachability.\n`,
  );
  log(`Wrote manual site cutover checklist to ${file}`);
}

async function migrateDnsRecords(context: ApiContext, manifest: Manifest) {
  const fromZoneId = requireZone(context, "from");
  const toZoneId = requireZone(context, "to");
  log("Listing DNS records...");
  const records = await listPaginated((page, perPage) =>
    cfJson(context, "from", `/zones/${fromZoneId}/dns_records?page=${page}&per_page=${perPage}`),
  );
  for (const rawRecord of records) {
    const source = asRecord(rawRecord);
    const id = stringValue(source.id) ?? `${source.type}:${source.name}`;
    await copyRecord(context, manifest, "dns", id, async () => {
      const payload = omitUndefined({
        type: source.type,
        name: source.name,
        content: source.content,
        ttl: source.ttl,
        proxied: source.proxied,
        priority: source.priority,
        data: source.data,
        comment: source.comment,
        tags: source.tags,
      });
      if (context.config.dryRun) return "planned";
      const existing = await findDnsRecord(context, toZoneId, source);
      if (existing) {
        await cfJson(context, "to", `/zones/${toZoneId}/dns_records/${encodeURIComponent(existing)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        return "updated";
      }
      await cfJson(context, "to", `/zones/${toZoneId}/dns_records`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return "created";
    });
  }
}

async function findDnsRecord(context: ApiContext, toZoneId: string, source: Record<string, unknown>) {
  const params = new URLSearchParams();
  const type = stringValue(source.type);
  const name = stringValue(source.name);
  if (type) params.set("type", type);
  if (name) params.set("name", name);
  const matches = await cfJson(context, "to", `/zones/${toZoneId}/dns_records?${params}`);
  return stringValue(asRecord(Array.isArray(matches) ? matches[0] : undefined).id);
}

async function migrateZoneSettings(context: ApiContext, manifest: Manifest) {
  const fromZoneId = requireZone(context, "from");
  const toZoneId = requireZone(context, "to");
  const settings = (await cfJson(context, "from", `/zones/${fromZoneId}/settings`)) as ZoneSettings[];
  const skip = new Set([
    "advanced_ddos",
    "always_use_https",
    "browser_check",
    "development_mode",
    "email_obfuscation",
    "ipv6",
    "min_tls_version",
    "ssl",
    "tls_1_3",
    "websockets",
  ]);
  for (const setting of settings) {
    const id = stringValue(asRecord(setting).id);
    if (!id || !skip.has(id)) continue;
    await copyRecord(context, manifest, "zone-settings", id, async () => {
      if (context.config.dryRun) return "planned";
      await cfJson(context, "to", `/zones/${toZoneId}/settings/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: asRecord(setting).value }),
      });
      return "updated";
    });
  }
}

async function migratePageRules(context: ApiContext, manifest: Manifest) {
  const fromZoneId = requireZone(context, "from");
  const toZoneId = requireZone(context, "to");
  const rules = await listPaginated((page, perPage) =>
    cfJson(context, "from", `/zones/${fromZoneId}/pagerules?page=${page}&per_page=${perPage}`),
  );
  for (const rawRule of rules) {
    const rule = asRecord(rawRule);
    const id = stringValue(rule.id) ?? stringValue(rule.description) ?? "page-rule";
    await copyRecord(context, manifest, "page-rules", id, async () => {
      if (context.config.dryRun) return "planned";
      await cfJson(context, "to", `/zones/${toZoneId}/pagerules`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          omitUndefined({ targets: rule.targets, actions: rule.actions, priority: rule.priority, status: rule.status }),
        ),
      });
      return "created";
    });
  }
}

async function migrateRulesets(context: ApiContext, manifest: Manifest) {
  const fromZoneId = requireZone(context, "from");
  const toZoneId = requireZone(context, "to");
  const phases = [
    "http_request_transform",
    "http_request_late_transform",
    "http_request_cache_settings",
    "http_request_firewall_custom",
    "http_ratelimit",
    "http_response_headers_transform",
    "http_request_origin",
    "http_request_dynamic_redirect",
    "http_request_redirect",
  ];
  for (const phase of phases) {
    let ruleset: unknown;
    try {
      ruleset = await cfJson(context, "from", `/zones/${fromZoneId}/rulesets/phases/${phase}/entrypoint`);
    } catch (error) {
      if (String(errorMessage(error)).includes("not found") || String(errorMessage(error)).includes("404")) continue;
      throw error;
    }
    const source = asRecord(ruleset);
    await copyRecord(context, manifest, "rulesets", phase, async () => {
      if (context.config.dryRun) return "planned";
      await cfJson(context, "to", `/zones/${toZoneId}/rulesets/phases/${phase}/entrypoint`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          omitUndefined({
            name: source.name,
            description: source.description,
            kind: "zone",
            phase,
            rules: source.rules,
          }),
        ),
      });
      return "updated";
    });
  }
}

async function migrateWorkersRoutes(context: ApiContext, manifest: Manifest) {
  const fromZoneId = requireZone(context, "from");
  const toZoneId = requireZone(context, "to");
  const routes = await listPaginated((page, perPage) =>
    cfJson(context, "from", `/zones/${fromZoneId}/workers/routes?page=${page}&per_page=${perPage}`),
  );
  for (const rawRoute of routes) {
    const route = asRecord(rawRoute);
    const id = stringValue(route.id) ?? stringValue(route.pattern) ?? "worker-route";
    await copyRecord(context, manifest, "workers-routes", id, async () => {
      if (context.config.dryRun) return "planned";
      await cfJson(context, "to", `/zones/${toZoneId}/workers/routes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(omitUndefined({ pattern: route.pattern, script: route.script })),
      });
      return "created";
    });
  }
}

async function migrateCustomHostnames(context: ApiContext, manifest: Manifest) {
  const fromZoneId = requireZone(context, "from");
  const toZoneId = requireZone(context, "to");
  const hostnames = await listPaginated((page, perPage) =>
    cfJson(context, "from", `/zones/${fromZoneId}/custom_hostnames?page=${page}&per_page=${perPage}`),
  );
  for (const rawHostname of hostnames) {
    const hostname = asRecord(rawHostname);
    const id = stringValue(hostname.id) ?? stringValue(hostname.hostname) ?? "custom-hostname";
    await copyRecord(context, manifest, "custom-hostnames", id, async () => {
      if (context.config.dryRun) return "planned";
      await cfJson(context, "to", `/zones/${toZoneId}/custom_hostnames`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          omitUndefined({ hostname: hostname.hostname, ssl: hostname.ssl, custom_metadata: hostname.custom_metadata }),
        ),
      });
      return "created";
    });
  }
}

async function copyRecord(
  context: ApiContext,
  manifest: Manifest,
  product: SiteProduct,
  id: string,
  run: () => Promise<SiteRecord["action"]>,
) {
  const record: SiteRecord = { product, id, action: "planned" };
  try {
    record.action = await run();
    log(`${product} ${id}: ${record.action}.`);
  } catch (error) {
    if (isAlreadyExists(error)) {
      record.action = "skipped";
    } else {
      record.error = errorMessage(error);
      manifest.errors.push({ product, id, error: record.error });
      logError(`${product} ${id}: ${record.error}`);
    }
  }
  manifest.site.push(record);
  await writeManifest(context.config, manifest);
}

function requireZone(context: ApiContext, side: "from" | "to") {
  const id = side === "from" ? context.config.fromZoneId : context.config.toZoneId;
  if (!id) throw new Error(`${side} zone ID is required`);
  return id;
}

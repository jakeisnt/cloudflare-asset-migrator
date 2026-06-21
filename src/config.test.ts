import { afterEach, describe, expect, test } from "bun:test";
import { createConfig } from "./config";

const managedEnvKeys = [
  "CF_FROM_ACCOUNT_ID",
  "CF_FROM_API_TOKEN",
  "CF_TO_ACCOUNT_ID",
  "CF_TO_API_TOKEN",
  "CF_MIGRATE_DRY_RUN",
  "CF_MIGRATE_MAX_RETRIES",
] as const;

const originalEnv = Object.fromEntries(managedEnvKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of managedEnvKeys) {
    const originalValue = originalEnv[key];
    if (originalValue === undefined) delete process.env[key];
    else process.env[key] = originalValue;
  }
});

describe("createConfig", () => {
  test("validates env values with Zod before building config", () => {
    process.env.CF_FROM_ACCOUNT_ID = "from";
    process.env.CF_FROM_API_TOKEN = "from-token";
    process.env.CF_TO_ACCOUNT_ID = "to";
    process.env.CF_TO_API_TOKEN = "to-token";
    process.env.CF_MIGRATE_MAX_RETRIES = "not-a-number";

    expect(() => createConfig({})).toThrow("Invalid environment configuration");
  });

  test("accepts validated env values", () => {
    process.env.CF_FROM_ACCOUNT_ID = "from";
    process.env.CF_FROM_API_TOKEN = "from-token";
    process.env.CF_TO_ACCOUNT_ID = "to";
    process.env.CF_TO_API_TOKEN = "to-token";
    process.env.CF_MIGRATE_DRY_RUN = "true";
    process.env.CF_MIGRATE_MAX_RETRIES = "3";

    const config = createConfig({});

    expect(config.dryRun).toBe(true);
    expect(config.maxRetries).toBe(3);
  });
});

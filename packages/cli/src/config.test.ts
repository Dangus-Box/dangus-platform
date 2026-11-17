import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, loadConfig, validateConfig } from "./config";

const valid = defineConfig({
  name: "produto",
  apps: { api: { domain: "api.produto.com" } },
  database: "postgres",
  deployTimeoutSeconds: 120,
});

test("applies default resources, redaction and Backup", () => {
  expect(validateConfig(valid)).toEqual({
    ...valid,
    apps: { api: { domain: "api.produto.com", memoryMb: 512, secrets: [] } },
    logger: { redact: [] },
    backup: { destination: "r2" },
  });
});

test("accepts explicit options", () => {
  expect(
    validateConfig({
      ...valid,
      apps: {
        web: { domain: "web-staging.produto.com", memoryMb: 1024 },
        mobile: { domain: "mobile.produto.com" },
      },
      database: "sqlite",
      logger: { redact: ["token"] },
      backup: { destination: "s3" },
    }).backup.destination,
  ).toBe("s3");
});

test("reports the exact path of invalid fields", () => {
  for (const [config, path] of [
    [{ ...valid, name: "" }, "name"],
    [{ ...valid, name: "Product" }, "name"],
    [{ ...valid, name: "produto; rm -rf /" }, "name"],
    [{ ...valid, name: "produto\nservice: other" }, "name"],
    [{ ...valid, apps: {} }, "apps"],
    [
      { ...valid, apps: { api: { domain: "api.produto.com", memoryMb: 0.5 } } },
      "apps.api.memoryMb",
    ],
    [
      {
        ...valid,
        apps: { api: { domain: "api.produto.com", secrets: ["invalid"] } },
      },
      "apps.api.secrets",
    ],
    [{ ...valid, deployTimeoutSeconds: 1.5 }, "deployTimeoutSeconds"],
    [
      { ...valid, apps: { api: { domain: "api.staging.produto.com" } } },
      "apps.api.domain",
    ],
    [
      { ...valid, apps: { api: { domain: "api.produto.com", memoryMb: -1 } } },
      "apps.api.memoryMb",
    ],
    [{ ...valid, database: "mysql" }, "database"],
    [{ ...valid, deployTimeoutSeconds: 0 }, "deployTimeoutSeconds"],
    [{ ...valid, logger: { redact: [42] } }, "logger.redact"],
    [{ ...valid, backup: { destination: "azure" } }, "backup.destination"],
    [
      { ...valid, apps: { api: { domain: "api.produto.com", extra: true } } },
      "apps.api.extra",
    ],
  ] as const)
    expect(() => validateConfig(config)).toThrow(path);
});

test("rejects secrets that collide with deploy or Platform variables", () => {
  for (const name of [
    "PATH",
    "HOME",
    "SSH_AUTH_SOCK",
    "DOCKER_HOST",
    "KAMAL_REGISTRY_PASSWORD",
    "DATABASE_URL",
    "POSTGRES_PASSWORD",
    "SQLITE_PATH",
  ])
    expect(() =>
      validateConfig({
        ...valid,
        apps: { api: { domain: "api.produto.com", secrets: [name] } },
      }),
    ).toThrow("apps.api.secrets");
});

test("names the default export when Config is not an object", () => {
  expect(() => validateConfig(undefined)).toThrow(
    "Product Config: export default: must be an object",
  );
});

test("loads and validates the Product dangus.config.ts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dangus-config-"));
  try {
    await writeFile(
      join(dir, "dangus.config.ts"),
      `export default ${JSON.stringify(valid)}`,
    );
    expect(await loadConfig(dir)).toEqual(validateConfig(valid));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

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
    apps: {
      api: {
        domain: "api.produto.com",
        memoryMb: 512,
        secrets: [],
        build: { secrets: [], args: {} },
        env: {},
        path: "apps/api",
        dockerfile: "apps/api/Dockerfile",
        entry: "apps/api/index.ts",
        healthcheckPath: "/ready",
      },
    },
    migrations: "drizzle",
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

test("resolves layout defaults for each App and accepts overrides", () => {
  const config = validateConfig({
    ...valid,
    migrations: "./database/migrations",
    apps: {
      api: {
        domain: "api.produto.com",
        path: "backend",
        dockerfile: "docker/api.Dockerfile",
        target: "API_prod-1.0",
        entry: "backend/src/main.ts",
        healthcheckPath: "/health/ready",
      },
      web: { domain: "web.produto.com", path: "frontend" },
      mobile: { domain: "mobile.produto.com" },
    },
  });
  expect(config.migrations).toBe("database/migrations");
  expect(config.apps.api).toMatchObject({
    path: "backend",
    dockerfile: "docker/api.Dockerfile",
    target: "API_prod-1.0",
    entry: "backend/src/main.ts",
    healthcheckPath: "/health/ready",
  });
  expect(config.apps.web).toMatchObject({
    path: "frontend",
    dockerfile: "frontend/Dockerfile",
    entry: "frontend/index.ts",
    healthcheckPath: "/",
  });
  expect(config.apps.mobile).toMatchObject({
    path: "apps/mobile",
    dockerfile: "apps/mobile/Dockerfile",
    entry: "apps/mobile/index.ts",
    healthcheckPath: "/",
  });
  expect(config.apps.web).not.toHaveProperty("target");
});

test("rejects invalid layout fields with their Config path", () => {
  for (const field of ["path", "dockerfile", "entry", "migrations"]) {
    for (const value of [
      "",
      "/absolute",
      "../outside",
      "src/../outside",
      "C:/absolute",
      "\\host\\share",
      "src\\..\\outside",
      "bad\0path",
      null,
      42,
    ]) {
      const input =
        field === "migrations"
          ? { ...valid, migrations: value }
          : { ...valid, apps: { api: { ...valid.apps.api, [field]: value } } };
      expect(() => validateConfig(input)).toThrow(
        field === "migrations" ? field : `apps.api.${field}`,
      );
    }
  }
  for (const [field, values] of [
    ["target", ["", "production target", "prod/target", "prod\n", null, 42]],
    ["healthcheckPath", ["", "ready", null, 42]],
  ] as const) {
    for (const value of values)
      expect(() =>
        validateConfig({
          ...valid,
          apps: { api: { ...valid.apps.api, [field]: value } },
        }),
      ).toThrow(`apps.api.${field}`);
  }
  expect(() => validateConfig({ ...valid, unknown: true })).toThrow("unknown");
  expect(() =>
    validateConfig({
      ...valid,
      apps: { backend: { domain: "api.produto.com" } },
    }),
  ).toThrow("apps.backend");
});

test("validates build and clear environment variables without revealing values", () => {
  const app = { domain: "api.produto.com" };
  const check = (fields: object) =>
    validateConfig({ ...valid, apps: { api: { ...app, ...fields } } });
  expect(
    check({
      build: {
        secrets: ["SSH_KEY"],
        args: { PUBLIC_URL: "https://example.com" },
      },
      env: { NODE_ENV: "production" },
    }).apps.api,
  ).toMatchObject({
    build: {
      secrets: ["SSH_KEY"],
      args: { PUBLIC_URL: "https://example.com" },
    },
    env: { NODE_ENV: "production" },
  });
  for (const name of ["lower", "_KEY", "1KEY", "HAS-DASH", "APP_VERSION"]) {
    for (const fields of [
      { secrets: [name] },
      { build: { secrets: [name] } },
      { build: { args: { [name]: "private-value" } } },
      { env: { [name]: "private-value" } },
    ])
      expect(() => check(fields)).toThrow();
  }
  for (const fields of [
    { build: { secrets: ["KEY", "KEY"] } },
    { env: { TOKEN: "private-value" }, secrets: ["TOKEN"] },
    { env: { TOKEN: "private-value" }, build: { secrets: ["TOKEN"] } },
    { build: { secrets: ["TOKEN"], args: { TOKEN: "private-value" } } },
    { build: { args: { TOKEN: "private-value" } }, secrets: ["TOKEN"] },
    { env: { NODE_ENV: "private-value\nsecond-line" } },
    { env: { NODE_ENV: "private-value\rsecond-line" } },
    { env: { NODE_ENV: 42 } },
    { env: null },
    { build: null },
    { build: { secrets: null } },
    { build: { args: null } },
    { build: { extra: true } },
  ]) {
    try {
      check(fields);
      throw new Error("Expected invalid Config");
    } catch (error) {
      expect(String(error)).toContain("Product Config:");
      expect(String(error)).not.toContain("private-value");
    }
  }
});

test("rejects ERB tags in public values because Kamal evaluates deploy.yml as ERB", () => {
  const check = (fields: object) =>
    validateConfig({
      ...valid,
      apps: { api: { domain: "api.produto.com", ...fields } },
    });
  for (const fields of [
    { env: { LEAK: "<%= ENV['SSH_KEY'] %>" } },
    { build: { args: { LEAK: "x <%= ENV['SSH_KEY'] %> y" } } },
  ])
    expect(() => check(fields)).toThrow("must not contain ERB tags");
  expect(check({ env: { PCT: "100% done %>" } }).apps.api?.env).toEqual({
    PCT: "100% done %>",
  });
});

test("rejects variables and secrets that collide with Platform-supplied names", () => {
  const check = (fields: object) =>
    validateConfig({
      ...valid,
      apps: { api: { domain: "api.produto.com", ...fields } },
    });
  for (const name of [
    "DATABASE_URL",
    "POSTGRES_PASSWORD",
    "SQLITE_PATH",
    "APP_VERSION",
  ])
    expect(() => check({ env: { [name]: "value" } })).toThrow(
      `apps.api.env.${name}`,
    );
  for (const name of [
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ENDPOINT",
    "HEALTHCHECKS_URL",
    "AGE_PUBLIC_KEY",
  ]) {
    expect(() => check({ secrets: [name] })).toThrow("apps.api.secrets");
    expect(() => check({ build: { secrets: [name] } })).toThrow(
      "apps.api.build.secrets",
    );
  }
});

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, loadConfig, validateConfig } from "./config";

const valid = defineConfig({
  name: "Produto",
  apps: { api: { domain: "api.produto.com" } },
  database: "postgres",
  deployTimeoutSeconds: 120,
});

test("aplica os padrões de recursos, redaction e Backup", () => {
  expect(validateConfig(valid)).toEqual({
    ...valid,
    apps: { api: { domain: "api.produto.com", memoryMb: 512 } },
    logger: { redact: [] },
    backup: { destination: "r2" },
  });
});

test("aceita opções explícitas", () => {
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

test("aponta o caminho exato dos campos inválidos", () => {
  for (const [config, path] of [
    [{ ...valid, name: "" }, "name"],
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

test("carrega e valida dangus.config.ts do Produto", async () => {
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

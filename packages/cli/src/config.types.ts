import { defineConfig } from "@dangus-box/cli";

defineConfig({
  name: "Product",
  apps: { api: { domain: "api.produto.com" } },
  database: "postgres",
  deployTimeoutSeconds: 120,
  // @ts-expect-error unknown fields are not part of Product Config
  unknown: true,
});

defineConfig({
  name: "Product",
  apps: {},
  // @ts-expect-error o banco aceita apenas postgres ou sqlite
  database: "mysql",
  deployTimeoutSeconds: 120,
});

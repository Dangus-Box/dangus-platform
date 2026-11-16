import { defineConfig } from "@dangus-box/cli";

defineConfig({
  name: "Produto",
  apps: { api: { domain: "api.produto.com" } },
  database: "postgres",
  deployTimeoutSeconds: 120,
  // @ts-expect-error campos desconhecidos não fazem parte da Config do Produto
  unknown: true,
});

defineConfig({
  name: "Produto",
  apps: {},
  // @ts-expect-error o banco aceita apenas postgres ou sqlite
  database: "mysql",
  deployTimeoutSeconds: 120,
});

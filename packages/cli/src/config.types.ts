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
  // @ts-expect-error the database accepts only postgres or sqlite
  database: "mysql",
  deployTimeoutSeconds: 120,
});

defineConfig({
  name: "product",
  apps: {
    api: {
      domain: "api.product.com",
      path: "backend",
      dockerfile: "docker/api.Dockerfile",
      target: "production",
      entry: "backend/src/main.ts",
      healthcheckPath: "/health",
    },
  },
  migrations: "database/migrations",
  database: "postgres",
  deployTimeoutSeconds: 120,
});

import { defineConfig } from "@dangus-box/cli";

export default defineConfig({
  name: "exemplo-postgres",
  apps: {
    api: { domain: "api-postgres.exemplo.com", memoryMb: 512 },
    web: { domain: "web-postgres.exemplo.com", memoryMb: 512 },
    mobile: { domain: "mobile-postgres.exemplo.com" },
  },
  database: "postgres",
  deployTimeoutSeconds: 120,
});

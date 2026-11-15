import { defineConfig } from "@dangus-box/cli";

export default defineConfig({
  name: "exemplo-sqlite",
  apps: {
    api: { domain: "api-sqlite.exemplo.com", memoryMb: 512 },
    web: { domain: "web-sqlite.exemplo.com", memoryMb: 512 },
    mobile: { domain: "mobile-sqlite.exemplo.com" },
  },
  database: "sqlite",
  deployTimeoutSeconds: 120,
});

import { defineConfig } from "@dangus-box/cli";

export default defineConfig({
  name: "exemplo-sqlite",
  apps: {
    api: {
      domain: "api-sqlite.dangus-box.com",
      memoryMb: 512,
      secrets: ["UNLEASH_TOKEN", "UMAMI_WEBSITE_ID"],
    },
    web: { domain: "web-sqlite.dangus-box.com", memoryMb: 512 },
    mobile: { domain: "mobile-sqlite.dangus-box.com" },
  },
  database: "sqlite",
  deployTimeoutSeconds: 120,
});

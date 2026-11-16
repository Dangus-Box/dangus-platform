import { defineConfig } from "@dangus-box/cli";

export default defineConfig({
  name: "exemplo-sqlite",
  apps: {
    api: { domain: "api-sqlite.dangus-box.com", memoryMb: 512 },
    web: {
      domain: "web-sqlite.dangus-box.com",
      memoryMb: 512,
      secrets: ["UMAMI_WEBSITE_ID", "FLAGS_FRONTEND_TOKEN"],
    },
    mobile: { domain: "mobile-sqlite.dangus-box.com" },
  },
  database: "sqlite",
  deployTimeoutSeconds: 120,
});

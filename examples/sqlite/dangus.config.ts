import { defineConfig } from "@dangus-box/cli";

export default defineConfig({
  name: "exemplo-sqlite",
  apps: {
    api: {
      domain: "api-sqlite.dangus-box.com",
      memoryMb: 512,
      secrets: ["UNLEASH_TOKEN", "UMAMI_WEBSITE_ID"],
    },
    web: {
      domain: "web-sqlite.dangus-box.com",
      memoryMb: 512,
      secrets: ["UMAMI_WEBSITE_ID", "FLAGS_FRONTEND_TOKEN"],
    },
    mobile: {
      domain: "mobile-sqlite.dangus-box.com",
      secrets: [
        "EXPO_PUBLIC_UMAMI_WEBSITE_ID",
        "EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN",
      ],
    },
  },
  database: "sqlite",
  deployTimeoutSeconds: 120,
});

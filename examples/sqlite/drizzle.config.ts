import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./apps/api/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: "./produto.sqlite" },
});

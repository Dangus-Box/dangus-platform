import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://produto:produto@localhost:55432/produto";
export const client = postgres(databaseUrl);
export const db = drizzle({ client });

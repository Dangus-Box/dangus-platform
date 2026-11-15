import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

export const client = postgres(
  process.env.DATABASE_URL ??
    "postgres://produto:produto@localhost:55432/produto",
);
export const db = drizzle(client);

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";

export const sqlite = new Database("produto.sqlite", { create: true });
export const db = drizzle(sqlite);

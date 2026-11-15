import type { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export function migrateSqlite(database: Database, migrationsFolder: string) {
  const migrations = readMigrationFiles({ migrationsFolder });
  database.run("PRAGMA busy_timeout = 30000");
  database.run("BEGIN IMMEDIATE");
  try {
    database.run(
      "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    const last = database
      .query<{ created_at: number }, []>(
        "SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    for (const migration of migrations) {
      if (!last || Number(last.created_at) < migration.folderMillis) {
        for (const statement of migration.sql) database.run(statement);
        database.run(
          "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)",
          [migration.hash, migration.folderMillis],
        );
      }
    }
    database.run("COMMIT");
  } catch (error) {
    database.run("ROLLBACK");
    throw error;
  }
}

export async function migratePostgres(url: string, migrationsFolder: string) {
  const client = postgres(url, { max: 1 });
  try {
    await client`SELECT pg_advisory_lock(184732017)`;
    try {
      await migrate(drizzle(client), { migrationsFolder });
    } finally {
      await client`SELECT pg_advisory_unlock(184732017)`;
    }
  } finally {
    await client.end();
  }
}

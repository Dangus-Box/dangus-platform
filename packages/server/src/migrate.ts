import type { Database } from "bun:sqlite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export function migrateSqlite(database: Database, migrationsFolder: string) {
  const migrations = readMigrationFiles({ migrationsFolder });
  database.run("PRAGMA busy_timeout = 30000");
  // The official rc.4 migrator issues BEGIN itself, so it cannot run inside
  // this write lock. Keep history upgrades and migration execution atomic here.
  database.run("BEGIN IMMEDIATE");
  try {
    database.run(
      "CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at text)",
    );
    const columns = database
      .query<{ name: string }, []>("PRAGMA table_info(__drizzle_migrations)")
      .all();
    if (!columns.some((column) => column.name === "name")) {
      const history = database
        .query<{ hash: string; created_at: number }, []>(
          "SELECT hash, created_at FROM __drizzle_migrations",
        )
        .all();
      database.run("ALTER TABLE __drizzle_migrations ADD COLUMN name text");
      database.run(
        "ALTER TABLE __drizzle_migrations ADD COLUMN applied_at text",
      );
      for (const row of history) {
        const candidates = migrations.filter(
          (migration) =>
            migration.folderMillis ===
            Math.floor(Number(row.created_at) / 1000) * 1000,
        );
        const migration =
          candidates.length === 1
            ? candidates[0]
            : migrations.find((migration) => migration.hash === row.hash);
        if (!migration)
          throw new Error("Applied migration is missing from local migrations");
        database.run(
          "UPDATE __drizzle_migrations SET name = ? WHERE hash = ? AND created_at = ?",
          [migration.name, row.hash, row.created_at],
        );
      }
    }
    const applied = new Set(
      database
        .query<{ name: string }, []>("SELECT name FROM __drizzle_migrations")
        .all()
        .map((row) => row.name),
    );
    for (const migration of migrations) {
      if (!applied.has(migration.name)) {
        for (const statement of migration.sql) database.run(statement);
        database.run(
          "INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at) VALUES (?, ?, ?, ?)",
          [
            migration.hash,
            migration.folderMillis,
            migration.name,
            new Date().toISOString(),
          ],
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
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await client`SELECT pg_advisory_lock(184732017)`;
    try {
      await migrate(drizzle({ client }), { migrationsFolder });
    } finally {
      await client`SELECT pg_advisory_unlock(184732017)`;
    }
  } finally {
    await client.end();
  }
}

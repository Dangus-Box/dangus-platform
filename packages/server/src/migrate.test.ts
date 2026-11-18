import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle as sqliteDrizzle } from "drizzle-orm/bun-sqlite";
import { migrate as migrateOfficialSqlite } from "drizzle-orm/bun-sqlite/migrator";
import { MIGRATIONS_TABLE_VERSIONS } from "drizzle-orm/up-migrations/utils";
import { drizzle as legacySqlite } from "drizzle-orm-legacy/bun-sqlite";
import { migrate as migrateLegacySqlite } from "drizzle-orm-legacy/bun-sqlite/migrator";
import { drizzle as legacyPostgres } from "drizzle-orm-legacy/postgres-js";
import { migrate as migrateLegacyPostgres } from "drizzle-orm-legacy/postgres-js/migrator";
import postgres from "postgres";
import { migratePostgres, migrateSqlite } from "./migrate";

const postgresUrl = process.env.POSTGRES_TEST_URL;
const fixture = join(import.meta.dir, "../test/boot.ts");

async function runBoots(kind: string, connection: string, fail: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "dangus-migration-"));
  await writeMigrations(dir, [
    fail
      ? "INVALID SQL;"
      : "CREATE TABLE applied_once (id integer);\n--> statement-breakpoint\nINSERT INTO applied_once VALUES (1);",
  ]);
  if (fail)
    await rename(
      join(dir, "20261117000000_test"),
      join(dir, "20261117000002_test"),
    );
  const servers = Array.from({ length: fail ? 1 : 2 }, () => {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    const port = listener.port;
    listener.stop();
    return {
      port,
      process: Bun.spawn(
        ["bun", fixture, kind, connection, dir, String(port)],
        { stdout: "ignore", stderr: "pipe" },
      ),
    };
  });
  try {
    for (const server of servers) {
      if (fail) {
        expect(await server.process.exited).not.toBe(0);
        await expect(
          fetch(`http://127.0.0.1:${server.port}/ready`),
        ).rejects.toThrow();
      } else {
        let ready = false;
        for (let i = 0; i < 200; i++) {
          try {
            ready =
              (await fetch(`http://127.0.0.1:${server.port}/ready`)).status ===
              200;
          } catch {}
          if (ready || server.process.exitCode !== null) break;
          await Bun.sleep(50);
        }
        if (!ready && server.process.exitCode !== null)
          console.error(await new Response(server.process.stderr).text());
        expect(ready).toBe(true);
      }
    }
    if (!fail && kind === "sqlite") {
      const db = new Database(connection);
      expect(db.query("SELECT * FROM applied_once").all()).toHaveLength(1);
      expect(db.query("SELECT * FROM __drizzle_migrations").all()).toHaveLength(
        1,
      );
      db.close();
    }
    if (!fail && kind === "postgres") {
      const db = postgres(connection);
      expect(await db`SELECT * FROM applied_once`).toHaveLength(1);
      expect(await db`SELECT * FROM drizzle.__drizzle_migrations`).toHaveLength(
        1,
      );
      await db.end();
    }
  } finally {
    for (const server of servers) {
      server.process.kill();
      await server.process.exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("SQLite: two processes become ready and apply the migration once; failure prevents readiness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dangus-sqlite-"));
  try {
    await runBoots("sqlite", join(dir, "success.sqlite"), false);
    await runBoots("sqlite", join(dir, "failure.sqlite"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test.skipIf(!postgresUrl)(
  "Postgres: two processes become ready and apply the migration once; failure prevents readiness",
  async () => {
    if (!postgresUrl) throw new Error("POSTGRES_TEST_URL missing");
    const admin = postgres(postgresUrl, { max: 1 });
    const name = `test_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(postgresUrl);
    url.pathname = `/${name}`;
    try {
      await runBoots("postgres", url.toString(), false);
      await runBoots("postgres", url.toString(), true);
    } finally {
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    }
  },
  30000,
);

async function writeMigrations(dir: string, migrations: string[]) {
  for (const [idx, sql] of migrations.entries()) {
    const folder = join(dir, `2026111700000${idx}_test`);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "migration.sql"), sql);
  }
}

function boot(kind: string, connection: string, dir: string) {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const port = listener.port;
  listener.stop();
  const process = Bun.spawn(
    ["bun", fixture, kind, connection, dir, String(port)],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  return { port, process };
}

async function waitReady({ port, process }: ReturnType<typeof boot>) {
  for (let i = 0; i < 400; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/ready`)).status === 200)
        return true;
    } catch {}
    if (process.exitCode !== null) return false;
    await Bun.sleep(50);
  }
  return false;
}

async function stop(boots: ReturnType<typeof boot>[]) {
  for (const { process } of boots) {
    process.kill();
    await process.exited;
  }
}

const slowSql = {
  sqlite:
    "CREATE TABLE slow (id integer);\n--> statement-breakpoint\nWITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 100000000) SELECT count(*) FROM c;",
  postgres:
    "CREATE TABLE slow (id integer);\n--> statement-breakpoint\nSELECT pg_sleep(5);",
};

async function withDatabase(
  kind: "sqlite" | "postgres",
  run: (
    connection: string,
    query: (sql: string) => Promise<unknown[]>,
  ) => Promise<void>,
) {
  if (kind === "sqlite") {
    const dir = await mkdtemp(join(tmpdir(), "dangus-sqlite-"));
    const connection = join(dir, "db.sqlite");
    try {
      await run(connection, async (sql) => {
        const db = new Database(connection);
        try {
          return db.query(sql).all();
        } finally {
          db.close();
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return;
  }
  if (!postgresUrl) throw new Error("POSTGRES_TEST_URL missing");
  const admin = postgres(postgresUrl, { max: 1 });
  const name = `test_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(postgresUrl);
  url.pathname = `/${name}`;
  const db = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await run(url.toString(), async (sql) => [...(await db.unsafe(sql))]);
  } finally {
    await db.end();
    await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

const historyTable = {
  sqlite: "__drizzle_migrations",
  postgres: "drizzle.__drizzle_migrations",
};

for (const kind of ["sqlite", "postgres"] as const) {
  const skip = kind === "postgres" && !postgresUrl;

  test.skipIf(skip)(
    `${kind}: five simultaneous processes apply the migration once and become ready`,
    async () => {
      await withDatabase(kind, async (connection, query) => {
        const dir = await mkdtemp(join(tmpdir(), "dangus-migration-"));
        await writeMigrations(dir, [
          "CREATE TABLE applied_once (id integer);\n--> statement-breakpoint\nINSERT INTO applied_once VALUES (1);",
          "INSERT INTO applied_once VALUES (2);",
        ]);
        const boots = Array.from({ length: 5 }, () =>
          boot(kind, connection, dir),
        );
        try {
          const ready = await Promise.all(boots.map(waitReady));
          expect(ready).toEqual([true, true, true, true, true]);
          expect(await query("SELECT * FROM applied_once")).toHaveLength(2);
          expect(
            await query(`SELECT * FROM ${historyTable[kind]}`),
          ).toHaveLength(2);
        } finally {
          await stop(boots);
          await rm(dir, { recursive: true, force: true });
        }
      });
    },
    60000,
  );

  test.skipIf(skip)(
    `${kind}: migration failure leaves no partial effects and the next boot recovers`,
    async () => {
      await withDatabase(kind, async (connection, query) => {
        const dir = await mkdtemp(join(tmpdir(), "dangus-migration-"));
        try {
          await writeMigrations(dir, [
            "CREATE TABLE first_ok (id integer);",
            "CREATE TABLE partial (id integer);\n--> statement-breakpoint\nINVALID SQL;",
          ]);
          const failed = boot(kind, connection, dir);
          expect(await failed.process.exited).not.toBe(0);
          expect(await waitReady(failed)).toBe(false);
          const tables = await query(
            kind === "sqlite"
              ? "SELECT name FROM sqlite_master WHERE name IN ('first_ok', 'partial')"
              : "SELECT tablename FROM pg_tables WHERE tablename IN ('first_ok', 'partial')",
          );
          expect(tables).toHaveLength(0);

          await writeMigrations(dir, [
            "CREATE TABLE first_ok (id integer);",
            "CREATE TABLE partial (id integer);",
          ]);
          const fixed = boot(kind, connection, dir);
          try {
            expect(await waitReady(fixed)).toBe(true);
          } finally {
            await stop([fixed]);
          }
          expect(
            await query(`SELECT * FROM ${historyTable[kind]}`),
          ).toHaveLength(2);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    },
    60000,
  );

  test.skipIf(skip)(
    `${kind}: a process killed during migration releases the lock and the next boot applies it`,
    async () => {
      await withDatabase(kind, async (connection, query) => {
        const slowDir = await mkdtemp(join(tmpdir(), "dangus-migration-"));
        const fastDir = await mkdtemp(join(tmpdir(), "dangus-migration-"));
        try {
          await writeMigrations(slowDir, [slowSql[kind]]);
          await writeMigrations(fastDir, ["CREATE TABLE slow (id integer);"]);
          const killed = boot(kind, connection, slowDir);
          await Bun.sleep(1000);
          expect(killed.process.exitCode).toBeNull();
          killed.process.kill("SIGKILL");
          await killed.process.exited;

          const started = Date.now();
          const next = boot(kind, connection, fastDir);
          try {
            expect(await waitReady(next)).toBe(true);
          } finally {
            await stop([next]);
          }
          expect(Date.now() - started).toBeLessThan(15000);
          expect(
            await query(`SELECT * FROM ${historyTable[kind]}`),
          ).toHaveLength(1);
        } finally {
          await rm(slowDir, { recursive: true, force: true });
          await rm(fastDir, { recursive: true, force: true });
        }
      });
    },
    60000,
  );
}

test.skipIf(!postgresUrl)(
  "postgres: boot does not write Postgres NOTICEs outside the JSON log",
  async () => {
    await withDatabase("postgres", async (connection) => {
      const dir = await mkdtemp(join(tmpdir(), "dangus-migration-"));
      try {
        await writeMigrations(dir, ["CREATE TABLE quiet (id integer);"]);
        for (let run = 0; run < 2; run++) {
          const migration = Bun.spawn(
            [
              "bun",
              "-e",
              `import { migratePostgres } from "${join(import.meta.dir, "migrate.ts")}"; await migratePostgres(process.argv[1], process.argv[2]);`,
              connection,
              dir,
            ],
            { stdout: "pipe", stderr: "pipe" },
          );
          expect(await migration.exited).toBe(0);
          const output =
            (await new Response(migration.stdout).text()) +
            (await new Response(migration.stderr).text());
          expect(output).not.toContain("NOTICE");
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  },
  60000,
);

for (const kind of ["sqlite", "postgres"] as const) {
  test.skipIf(kind === "postgres" && !postgresUrl)(
    `${kind}: a 0.44.7 history upgrades without replay and accepts the next migration`,
    async () => {
      await withDatabase(kind, async (connection, query) => {
        const dir = await mkdtemp(join(tmpdir(), "dangus-legacy-"));
        const sql =
          "CREATE TABLE legacy_data (id integer);\n--> statement-breakpoint\nINSERT INTO legacy_data VALUES (42);";
        const sqlite = kind === "sqlite" ? new Database(connection) : undefined;
        const client =
          kind === "postgres"
            ? postgres(connection, { onnotice: () => {} })
            : undefined;
        try {
          await mkdir(join(dir, "meta"));
          await writeFile(
            join(dir, "meta/_journal.json"),
            JSON.stringify({
              entries: [
                {
                  idx: 0,
                  when: 1794873600123,
                  tag: "0000_test",
                  breakpoints: true,
                },
              ],
            }),
          );
          await writeFile(join(dir, "0000_test.sql"), sql);
          if (sqlite)
            migrateLegacySqlite(legacySqlite(sqlite), {
              migrationsFolder: dir,
            });
          if (client)
            await migrateLegacyPostgres(legacyPostgres(client), {
              migrationsFolder: dir,
            });
          await rm(join(dir, "meta"), { recursive: true });
          await rm(join(dir, "0000_test.sql"));
          await writeMigrations(dir, [
            sql,
            "INSERT INTO legacy_data VALUES (43);",
          ]);
          // The official SQLite migrator also recognizes the legacy history,
          // but cannot be nested inside the SDK's BEGIN IMMEDIATE.
          if (sqlite) {
            const cloned = Database.deserialize(sqlite.serialize());
            try {
              migrateOfficialSqlite(sqliteDrizzle({ client: cloned }), {
                migrationsFolder: dir,
              });
              expect(
                cloned.query("SELECT * FROM legacy_data").all(),
              ).toHaveLength(2);
            } finally {
              cloned.close();
            }
          }
          for (let attempt = 0; attempt < 2; attempt++) {
            if (sqlite) migrateSqlite(sqlite, dir);
            else await migratePostgres(connection, dir);
          }
          expect(await query("SELECT id FROM legacy_data ORDER BY id")).toEqual(
            [{ id: 42 }, { id: 43 }],
          );
          const history = await query(
            `SELECT name FROM ${historyTable[kind]} ORDER BY created_at`,
          );
          expect(history).toEqual([
            { name: "20261117000000_test" },
            { name: "20261117000001_test" },
          ]);
        } finally {
          sqlite?.close();
          await client?.end();
          await rm(dir, { recursive: true, force: true });
        }
      });
    },
    30000,
  );
}

test("SQLite: an SDK 1.0.0 history with a null id upgrades, and missing history rolls back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dangus-sdk-history-"));
  const db = new Database(":memory:");
  try {
    await writeMigrations(dir, ["CREATE TABLE already_applied (id integer);"]);
    db.run("CREATE TABLE already_applied (id integer)");
    db.run(
      "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    db.run(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('old-hash', 1794873600123)",
    );
    migrateSqlite(db, dir);
    migrateSqlite(db, dir);
    expect(db.query("SELECT id, name FROM __drizzle_migrations").all()).toEqual(
      [{ id: null, name: "20261117000000_test" }],
    );
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }

  const missing = new Database(":memory:");
  const empty = await mkdtemp(join(tmpdir(), "dangus-missing-history-"));
  try {
    missing.run(
      "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    missing.run(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('missing', 1794873600123)",
    );
    expect(() => migrateSqlite(missing, empty)).toThrow(
      "Applied migration is missing",
    );
    expect(
      missing.query("PRAGMA table_info(__drizzle_migrations)").all(),
    ).toHaveLength(3);
  } finally {
    missing.close();
    await rm(empty, { recursive: true, force: true });
  }
});

test.skipIf(!postgresUrl)(
  "postgres: a failed in-process run releases the advisory lock and rolls back every migration",
  async () => {
    await withDatabase("postgres", async (connection, query) => {
      const dir = await mkdtemp(join(tmpdir(), "dangus-migration-"));
      try {
        await writeMigrations(dir, [
          "CREATE TABLE first_ok (id integer);",
          "CREATE TABLE partial (id integer);\n--> statement-breakpoint\nINVALID SQL;",
        ]);
        await expect(migratePostgres(connection, dir)).rejects.toThrow();
        expect(
          await query("SELECT * FROM pg_locks WHERE locktype = 'advisory'"),
        ).toHaveLength(0);
        expect(
          await query(
            "SELECT tablename FROM pg_tables WHERE tablename IN ('first_ok', 'partial')",
          ),
        ).toHaveLength(0);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  },
  30000,
);

test.skipIf(!postgresUrl)(
  "postgres: concurrent migrators upgrade a 0.44.7 history once under the lock",
  async () => {
    await withDatabase("postgres", async (connection, query) => {
      const dir = await mkdtemp(join(tmpdir(), "dangus-legacy-"));
      const sql =
        "CREATE TABLE legacy_data (id integer);\n--> statement-breakpoint\nINSERT INTO legacy_data VALUES (42);";
      const client = postgres(connection, { onnotice: () => {} });
      try {
        await mkdir(join(dir, "meta"));
        await writeFile(
          join(dir, "meta/_journal.json"),
          JSON.stringify({
            entries: [
              {
                idx: 0,
                when: 1794873600123,
                tag: "0000_test",
                breakpoints: true,
              },
            ],
          }),
        );
        await writeFile(join(dir, "0000_test.sql"), sql);
        await migrateLegacyPostgres(legacyPostgres(client), {
          migrationsFolder: dir,
        });
        await rm(join(dir, "meta"), { recursive: true });
        await rm(join(dir, "0000_test.sql"));
        await writeMigrations(dir, [
          sql,
          "SELECT pg_sleep(0.3);\n--> statement-breakpoint\nINSERT INTO legacy_data VALUES (43);",
        ]);
        await Promise.all(
          Array.from({ length: 6 }, () => migratePostgres(connection, dir)),
        );
        expect(await query("SELECT id FROM legacy_data ORDER BY id")).toEqual([
          { id: 42 },
          { id: 43 },
        ]);
        expect(
          await query(
            "SELECT name FROM drizzle.__drizzle_migrations ORDER BY created_at",
          ),
        ).toEqual([
          { name: "20261117000000_test" },
          { name: "20261117000001_test" },
        ]);
      } finally {
        await client.end();
        await rm(dir, { recursive: true, force: true });
      }
    });
  },
  60000,
);

test("SQLite: the SDK and the official rc.4 migrator recognize each other's history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dangus-interop-"));
  try {
    await writeMigrations(dir, [
      "CREATE TABLE interop (id integer);",
      "INSERT INTO interop VALUES (1);",
    ]);
    const sdkFirst = new Database(":memory:");
    migrateSqlite(sdkFirst, dir);
    migrateOfficialSqlite(sqliteDrizzle({ client: sdkFirst }), {
      migrationsFolder: dir,
    });
    expect(sdkFirst.query("SELECT * FROM interop").all()).toHaveLength(1);
    sdkFirst.close();

    const officialFirst = new Database(":memory:");
    migrateOfficialSqlite(sqliteDrizzle({ client: officialFirst }), {
      migrationsFolder: dir,
    });
    migrateSqlite(officialFirst, dir);
    expect(officialFirst.query("SELECT * FROM interop").all()).toHaveLength(1);
    expect(
      officialFirst.query("SELECT * FROM __drizzle_migrations").all(),
    ).toHaveLength(2);
    officialFirst.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite: a legacy row whose timestamp matches no folder is matched by its real hash", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dangus-legacy-hash-"));
  const db = new Database(":memory:");
  try {
    const sql = "CREATE TABLE by_hash (id integer);";
    await writeMigrations(dir, [sql]);
    db.run(sql);
    db.run(
      "CREATE TABLE __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)",
    );
    db.run(
      "INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, 1700000000000)",
      [new Bun.CryptoHasher("sha256").update(sql).digest("hex")],
    );
    migrateSqlite(db, dir);
    expect(db.query("SELECT name FROM __drizzle_migrations").all()).toEqual([
      { name: "20261117000000_test" },
    ]);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite: the SDK history format matches the drizzle-orm version it reimplements", () => {
  // migrateSqlite mirrors drizzle's SQLite history table v1; a drizzle bump
  // that changes it must update migrateSqlite too.
  expect(MIGRATIONS_TABLE_VERSIONS.sqlite).toBe(1);
});

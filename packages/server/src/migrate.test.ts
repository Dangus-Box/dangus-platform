import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

const postgresUrl = process.env.POSTGRES_TEST_URL;
const fixture = join(import.meta.dir, "../test/boot.ts");

async function runBoots(kind: string, connection: string, fail: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "dangus-migration-"));
  await mkdir(join(dir, "meta"));
  await writeFile(
    join(dir, "meta/_journal.json"),
    JSON.stringify({
      entries: [
        { idx: 0, when: fail ? 2 : 1, tag: "0000_test", breakpoints: true },
      ],
    }),
  );
  await writeFile(
    join(dir, "0000_test.sql"),
    fail
      ? "INVALID SQL;"
      : "CREATE TABLE applied_once (id integer);\n--> statement-breakpoint\nINSERT INTO applied_once VALUES (1);",
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
  await mkdir(join(dir, "meta"), { recursive: true });
  await writeFile(
    join(dir, "meta/_journal.json"),
    JSON.stringify({
      entries: migrations.map((_, idx) => ({
        idx,
        when: idx + 1,
        tag: `000${idx}_test`,
        breakpoints: true,
      })),
    }),
  );
  for (const [idx, sql] of migrations.entries())
    await writeFile(join(dir, `000${idx}_test.sql`), sql);
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

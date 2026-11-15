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

test("SQLite: dois processos ficam prontos e aplicam a migration uma vez; falha impede readiness", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dangus-sqlite-"));
  try {
    await runBoots("sqlite", join(dir, "success.sqlite"), false);
    await runBoots("sqlite", join(dir, "failure.sqlite"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

test.skipIf(!postgresUrl)(
  "Postgres: dois processos ficam prontos e aplicam a migration uma vez; falha impede readiness",
  async () => {
    if (!postgresUrl) throw new Error("POSTGRES_TEST_URL ausente");
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

import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { doctor, lintSql, run } from "./doctor";

const example = resolve(
  import.meta.dir,
  "../../../examples/postgres/apps/api/index.ts",
);
const connected = async (args: string[], cwd: string) =>
  args[0] === "tailscale" ? { code: 0, output: "" } : run(args, cwd);
const lockfile = (spec: string, resolved: string) =>
  JSON.stringify({
    workspaces: { "": { devDependencies: { "@dangus-box/cli": spec } } },
    packages: { "@dangus-box/cli": [`@dangus-box/cli@${resolved}`] },
  });
async function migration(dir: string, path: string, sql: string) {
  await mkdir(join(dir, path), { recursive: true });
  await writeFile(join(dir, path, "migration.sql"), sql);
}

async function commit(dir: string) {
  await run(["git", "add", "."], dir);
  await run(
    [
      "git",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "migration",
    ],
    dir,
  );
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "dangus-doctor-"));
  await mkdir(join(dir, "apps/api"), { recursive: true });
  await mkdir(join(dir, "drizzle"));
  await writeFile(
    join(dir, "dangus.config.ts"),
    'export default { name: "produto", apps: { api: { domain: "api.produto.com" } }, database: "postgres", deployTimeoutSeconds: 120 };',
  );
  await writeFile(
    join(dir, "apps/api/index.ts"),
    await Bun.file(example).text(),
  );
  await writeFile(join(dir, "bun.lock"), lockfile("1.2.3", "1.2.3"));
  await run(["git", "init", "-q"], dir);
  await run(
    [
      "git",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "base",
    ],
    dir,
  );
  return dir;
}

test("checks pass and fail with specific instructions", async () => {
  const dir = await fixture();
  try {
    expect((await doctor(dir, "HEAD", connected)).map((r) => r.status)).toEqual(
      ["pass", "pass", "pass", "pass"],
    );
    await writeFile(join(dir, "apps/api/index.ts"), "");
    await writeFile(join(dir, "bun.lock"), "{}");
    await migration(dir, "drizzle/202611170001_new", "drop table users;");
    const results = await doctor(dir, "HEAD", async (args, cwd) =>
      args[0] === "tailscale" ? { code: 1, output: "" } : run(args, cwd),
    );
    expect(results.map((r) => r.status)).toEqual([
      "fail",
      "fail",
      "fail",
      "fail",
    ]);
    expect(results.map((r) => r.message).join(" ")).toContain("remove DROP");
    expect(results[0]?.message).toContain("apps/api/index.ts");
    expect(results[1]?.message).toContain("bun.lock");
    expect(results[2]?.message).toContain("tailscale status");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lint ignores comments and literals and recognizes operations case-insensitively", () => {
  expect(
    lintSql(
      "-- DROP table x\nSELECT 'RENAME'; /* CREATE INDEX x */ CREATE INDEX CONCURRENTLY x ON t(c);",
    ),
  ).toEqual([]);
  const issues = lintSql(
    'rename table a to b; DROP table a; alter table t alter column "x" type text; alter table t alter column x set not null; create unique index x on t(c);',
  );
  expect(issues.map((r) => r.status)).toEqual([
    "fail",
    "fail",
    "warn",
    "warn",
    "warn",
  ]);
});

test("existing migrations in the ref are ignored, warnings pass and a missing ref fails", async () => {
  const dir = await fixture();
  try {
    await migration(dir, "drizzle/202611170001_old", "DROP TABLE t;");
    await run(["git", "add", "drizzle/202611170001_old"], dir);
    await run(
      [
        "git",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "migration",
      ],
      dir,
    );
    await migration(
      dir,
      "drizzle/202611170002_new",
      "CREATE INDEX idx ON t(c);",
    );
    const results = await doctor(dir, "HEAD", connected);
    expect(results.map((r) => r.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "warn",
    ]);
    expect((await doctor(dir, "missing-ref", connected)).at(-1)?.status).toBe(
      "fail",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor returns CI status for warnings and failures", async () => {
  const dir = await fixture();
  try {
    const tailscale = join(dir, "tailscale");
    await writeFile(tailscale, "#!/bin/sh\nexit 0\n");
    await chmod(tailscale, 0o755);
    await migration(
      dir,
      "drizzle/202611170002_new",
      "CREATE INDEX idx ON t(c);",
    );
    const command = [
      process.execPath,
      resolve(import.meta.dir, "index.ts"),
      "doctor",
      "--base",
      "HEAD",
    ];
    const execute = async () => {
      const proc = Bun.spawn(command, {
        cwd: dir,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        stdout: "pipe",
      });
      return {
        output: await new Response(proc.stdout).text(),
        code: await proc.exited,
      };
    };
    const warning = await execute();
    expect(warning.code).toBe(0);
    expect(warning.output).toContain("[warn]");
    await migration(dir, "drizzle/202611170002_new", "DROP TABLE t;");
    const failure = await execute();
    expect(failure.code).toBe(1);
    expect(failure.output).toContain("[fail]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lint covers Drizzle DDL and DO blocks and reports the line", () => {
  const statuses = (sql: string) => lintSql(sql).map((r) => r.status);
  for (const sql of [
    "create index concurrently x on t(c);",
    "CREATE UNIQUE INDEX CONCURRENTLY x ON t(c);",
    'CREATE TABLE "a" (\n\t"dropped_at" timestamp\n);\n--> statement-breakpoint\nALTER TABLE "a" ADD COLUMN "b" text;',
    "INSERT INTO t VALUES ('it''s DROP');",
  ])
    expect(statuses(sql)).toEqual([]);
  for (const sql of [
    'ALTER TABLE "t" DROP COLUMN "c";',
    'ALTER TABLE "t" RENAME COLUMN "a" TO "b";',
    "alter table t\n  drop\n  column c;",
    "DO $$ BEGIN DROP TABLE x; END $$;",
  ])
    expect(statuses(sql)).toEqual(["fail"]);
  expect(statuses("ALTER TABLE t ALTER c TYPE int;")).toEqual(["warn"]);
  expect(
    lintSql(
      'CREATE TABLE "a" ("id" int);\n--> statement-breakpoint\nDROP TABLE "b";\n--> statement-breakpoint\n/* x\n */ DROP TABLE "c";',
    ).map((r) => r.line),
  ).toEqual([3, 6]);
});

test("CLI requires an exact version in bun.lock", async () => {
  const dir = await fixture();
  const cli = async () =>
    (await doctor(dir, "HEAD", connected)).find(
      (r) =>
        r.message.startsWith("CLI") || r.message.includes("CLI version pinned"),
    );
  try {
    expect((await cli())?.status).toBe("pass");
    for (const [spec, resolved] of [
      ["^1.2.3", "1.2.3"],
      ["~1.2.3", "1.2.3"],
      ["latest", "1.2.3"],
      ["workspace:*", "workspace:packages/cli"],
      ["file:../cli", "file:../cli"],
      ["link:@dangus-box/cli", "link:@dangus-box/cli"],
    ] as const) {
      await writeFile(join(dir, "bun.lock"), lockfile(spec, resolved));
      const check = await cli();
      expect(check?.status).toBe("fail");
      expect(check?.message).toContain("--exact");
    }
    await rm(join(dir, "bun.lock"));
    expect((await cli())?.status).toBe("fail");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor uses configured API entry and migrations, including the base ref", async () => {
  const dir = await fixture();
  try {
    await mkdir(join(dir, "backend/src"), { recursive: true });
    await mkdir(join(dir, "database/migrations"), { recursive: true });
    await writeFile(
      join(dir, "dangus.config.ts"),
      `export default {
      name: "produto", apps: { api: { domain: "api.produto.com",
        path: "backend", entry: "backend/src/main.ts" } },
      migrations: "./database/migrations", database: "postgres", deployTimeoutSeconds: 120,
    }`,
    );
    await writeFile(join(dir, "apps/api/index.ts"), "");
    await writeFile(
      join(dir, "backend/src/main.ts"),
      await Bun.file(example).text(),
    );
    await migration(
      dir,
      "database/migrations/202611170001_old",
      "DROP TABLE old;",
    );
    await run(["git", "add", "database/migrations/202611170001_old"], dir);
    await run(
      [
        "git",
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-qm",
        "base",
      ],
      dir,
    );
    await writeFile(join(dir, "drizzle/ignored.sql"), "DROP TABLE ignored;");
    expect((await doctor(dir, "HEAD", connected)).map((r) => r.status)).toEqual(
      ["pass", "pass", "pass", "pass"],
    );
    await migration(
      dir,
      "database/migrations/202611170002_new",
      "DROP TABLE new;",
    );
    const results = await doctor(dir, "HEAD", connected);
    expect(results.at(-1)?.message).toContain(
      "database/migrations/202611170002_new/migration.sql:1",
    );
    expect(results.at(-1)?.status).toBe("fail");
    await writeFile(join(dir, "backend/src/main.ts"), "");
    expect((await doctor(dir, "HEAD", connected))[0]?.message).toContain(
      "backend/src/main.ts",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("new migration folders in HEAD are linted from a Product in a Git subfolder", async () => {
  const dir = await fixture();
  try {
    const product = join(dir, "products/product");
    await mkdir(product, { recursive: true });
    await writeFile(
      join(product, "dangus.config.ts"),
      `export default {
      name: "produto", apps: { web: { domain: "web.produto.com" } }, database: "postgres", migrations: "packages/db/migrations", deployTimeoutSeconds: 120,
    };`,
    );
    await writeFile(join(product, "bun.lock"), lockfile("1.2.3", "1.2.3"));
    const migrations = "products/product/packages/db/migrations";
    await migration(dir, `${migrations}/202611170001_base`, "DROP TABLE old;");
    await commit(dir);
    await run(["git", "branch", "base"], dir);
    await migration(
      dir,
      `${migrations}/202611170002_new`,
      "-- new migration\nDROP TABLE users;",
    );
    await commit(dir);
    const results = await doctor(product, "base", connected);
    expect(results.filter((r) => r.status === "fail")).toEqual([
      {
        status: "fail",
        message:
          "Migrations: packages/db/migrations/202611170002_new/migration.sql:2: remove DROP and perform the removal in a later deploy.",
      },
    ]);
    expect((await doctor(product, "HEAD", connected)).at(-1)).toEqual({
      status: "pass",
      message: "New migrations are additive.",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects the Drizzle 0.x flat layout even when it exists in the base ref", async () => {
  const dir = await fixture();
  try {
    await writeFile(
      join(dir, "drizzle/0000_old.sql"),
      "CREATE TABLE t(id int);",
    );
    await commit(dir);
    const result = (await doctor(dir, "HEAD", connected)).at(-1);
    expect(result?.status).toBe("fail");
    expect(result?.message).toContain("drizzle/0000_old.sql");
    expect(result?.message).toContain("unsupported Drizzle 0.x");
    expect(result?.message).toContain(
      "<migrations>/<timestamp>_<name>/migration.sql",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

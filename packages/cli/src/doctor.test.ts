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

test("verificações passam e falham com instruções específicas", async () => {
  const dir = await fixture();
  try {
    expect((await doctor(dir, "HEAD", connected)).map((r) => r.status)).toEqual(
      ["pass", "pass", "pass", "pass"],
    );
    await writeFile(join(dir, "apps/api/index.ts"), "");
    await writeFile(join(dir, "bun.lock"), "{}");
    await writeFile(join(dir, "drizzle/0001.sql"), "drop table users;");
    const results = await doctor(dir, "HEAD", async (args, cwd) =>
      args[0] === "tailscale" ? { code: 1, output: "" } : run(args, cwd),
    );
    expect(results.map((r) => r.status)).toEqual([
      "fail",
      "fail",
      "fail",
      "fail",
    ]);
    expect(results.map((r) => r.message).join(" ")).toContain("remova DROP");
    expect(results[0]?.message).toContain("apps/api/index.ts");
    expect(results[1]?.message).toContain("bun.lock");
    expect(results[2]?.message).toContain("tailscale status");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lint ignora comentários e literais e reconhece operações sem distinguir maiúsculas", () => {
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

test("migrations existentes na ref são ignoradas, avisos não falham e ref ausente falha", async () => {
  const dir = await fixture();
  try {
    await writeFile(join(dir, "drizzle/old.sql"), "DROP TABLE t;");
    await run(["git", "add", "drizzle/old.sql"], dir);
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
    await writeFile(join(dir, "drizzle/new.sql"), "CREATE INDEX idx ON t(c);");
    const results = await doctor(dir, "HEAD", connected);
    expect(results.map((r) => r.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "warn",
    ]);
    expect((await doctor(dir, "ref-ausente", connected)).at(-1)?.status).toBe(
      "fail",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor retorna código de CI para aviso e falha", async () => {
  const dir = await fixture();
  try {
    const tailscale = join(dir, "tailscale");
    await writeFile(tailscale, "#!/bin/sh\nexit 0\n");
    await chmod(tailscale, 0o755);
    await writeFile(join(dir, "drizzle/new.sql"), "CREATE INDEX idx ON t(c);");
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
    await writeFile(join(dir, "drizzle/new.sql"), "DROP TABLE t;");
    const failure = await execute();
    expect(failure.code).toBe(1);
    expect(failure.output).toContain("[fail]");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lint cobre DDL do Drizzle, blocos DO e informa a linha", () => {
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

test("CLI precisa de versão exata no bun.lock", async () => {
  const dir = await fixture();
  const cli = async () =>
    (await doctor(dir, "HEAD", connected)).find((r) =>
      r.message.startsWith("CLI") || r.message.includes("CLI fixada"),
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

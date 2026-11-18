import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config";

type Result = { status: "pass" | "warn" | "fail"; message: string };
type Issue = Result & { line: number };
type Runner = (
  args: string[],
  cwd: string,
) => Promise<{ code: number; output: string }>;
export const run: Runner = async (args, cwd) => {
  try {
    const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "ignore" });
    return {
      code: await proc.exited,
      output: await new Response(proc.stdout).text(),
    };
  } catch {
    return { code: 1, output: "" };
  }
};
const result = (status: Result["status"], message: string): Result => ({
  status,
  message,
});

export async function doctor(
  directory: string,
  base = "origin/main",
  runner: Runner = run,
): Promise<Result[]> {
  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(directory);
  } catch (error) {
    return [
      result("fail", `Product Config: fix dangus.config.ts: ${String(error)}`),
    ];
  }
  const results: Result[] = [];
  if (config.apps.api) {
    const path = resolve(directory, config.apps.api.entry);
    const source = await Bun.file(path)
      .text()
      .catch(() => "");
    const migration =
      config.database === "postgres" ? "migratePostgres" : "migrateSqlite";
    const imported =
      /import\s*\{([^}]+)\}\s*from\s*["']@dangus-box\/server["']/s.exec(
        source,
      )?.[1] ?? "";
    const listen = source.search(/\.listen\s*\(/);
    const obs = source.search(/\bobservability\s*\(/);
    const migrate = source.search(new RegExp(`\\b${migration}\\s*\\(`));
    const ok =
      new RegExp(`\\b${migration}\\b`).test(imported) &&
      /\bobservability\b/.test(imported) &&
      obs >= 0 &&
      migrate >= 0 &&
      listen > obs &&
      listen > migrate;
    results.push(
      result(
        ok ? "pass" : "fail",
        ok
          ? "SDK integration in API present."
          : `API: in ${config.apps.api.entry}, import observability and ${migration} from @dangus-box/server and run both before .listen().`,
      ),
    );
  } else results.push(result("pass", "SDK integration: Product has no API."));
  const exact = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
  try {
    const lock = (
      Bun as typeof Bun & { JSONC: { parse(text: string): unknown } }
    ).JSONC.parse(await Bun.file(resolve(directory, "bun.lock")).text()) as {
      workspaces?: Record<string, Record<string, Record<string, string>>>;
      packages?: Record<string, unknown>;
    };
    const root = lock.workspaces?.[""];
    const spec =
      root?.dependencies?.["@dangus-box/cli"] ??
      root?.devDependencies?.["@dangus-box/cli"];
    const entry = lock.packages?.["@dangus-box/cli"];
    if (
      !spec ||
      !exact.test(spec) ||
      !Array.isArray(entry) ||
      entry[0] !== `@dangus-box/cli@${spec}`
    )
      throw new Error();
    results.push(result("pass", `CLI version pinned in bun.lock: ${spec}.`));
  } catch {
    results.push(
      result(
        "fail",
        "CLI: pin a published version with bun add --dev --exact @dangus-box/cli@<version> and include bun.lock in the repository.",
      ),
    );
  }
  const tailscale = await runner(["tailscale", "status"], directory);
  results.push(
    result(
      tailscale.code === 0 ? "pass" : "fail",
      tailscale.code === 0
        ? "Tailscale connected."
        : "Tailscale: install and connect Tailscale; confirm with tailscale status.",
    ),
  );
  const git = await runner(["git", "rev-parse", "--show-prefix"], directory);
  const ref = await runner(
    ["git", "rev-parse", "--verify", `${base}^{commit}`],
    directory,
  );
  if (git.code || ref.code) {
    results.push(
      result(
        "fail",
        `Migrations: make Git ref ${base} available (for example, git fetch origin main) or provide --base <ref>.`,
      ),
    );
    return results;
  }
  const existing = await runner(
    [
      "git",
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      base,
      "--",
      `${git.output.trim()}${config.migrations}`,
    ],
    directory,
  );
  if (existing.code) {
    results.push(
      result("fail", `Migrations: could not read ${base}; check the Git ref.`),
    );
    return results;
  }
  const old = new Set(existing.output.split("\0"));
  const files = new Bun.Glob("**/*.sql");
  let found = false;
  const migrationsDirectory = resolve(directory, config.migrations);
  const migrations = existsSync(migrationsDirectory)
    ? files.scan({ cwd: migrationsDirectory, onlyFiles: true })
    : [];
  for await (const relative of migrations) {
    const file = join(config.migrations, relative);
    if (old.has(`${git.output.trim()}${file}`)) continue;
    for (const issue of lintSql(
      await Bun.file(resolve(directory, file)).text(),
    )) {
      found = true;
      results.push(
        result(
          issue.status,
          `Migrations: ${file}:${issue.line}: ${issue.message}`,
        ),
      );
    }
  }
  if (!found) results.push(result("pass", "New migrations are additive."));
  return results;
}

export function lintSql(sql: string): Issue[] {
  // Hide comments, literals and quoted identifiers while preserving
  // positions; $$ bodies (DO blocks) remain analyzed because they execute SQL.
  const clean = sql.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"/g,
    (match) =>
      match.startsWith('"')
        ? `"${"x".repeat(match.length - 2)}"`
        : match.replace(/[^\n]/g, " "),
  );
  const issues: Issue[] = [];
  let offset = 0;
  for (const statement of clean.split(";")) {
    const start = offset + statement.search(/\S|$/);
    const line = clean.slice(0, start).split("\n").length;
    offset += statement.length + 1;
    const add = (status: Result["status"], message: string) =>
      issues.push({ status, message, line });
    if (/\bDROP\b/i.test(statement))
      add("fail", "remove DROP and perform the removal in a later deploy.");
    if (/\bRENAME\b/i.test(statement))
      add(
        "fail",
        "replace RENAME with an additive migration across two deploys.",
      );
    if (
      /\bALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(statement)
    )
      add(
        "warn",
        "avoid ALTER COLUMN TYPE; plan the change without locking the table.",
      );
    if (/\bSET\s+NOT\s+NULL\b/i.test(statement))
      add(
        "warn",
        "avoid SET NOT NULL; plan validation without locking the table.",
      );
    if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)/i.test(statement))
      add("warn", "use CREATE INDEX CONCURRENTLY to avoid locking the table.");
  }
  return issues;
}

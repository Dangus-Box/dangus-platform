import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
      "-d",
      "--full-tree",
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
  const files = new Bun.Glob("*/migration.sql");
  const migrationsDirectory = resolve(directory, config.migrations);
  let found = false;
  if (existsSync(migrationsDirectory)) {
    for await (const file of new Bun.Glob("*.sql").scan({
      cwd: migrationsDirectory,
      onlyFiles: true,
    })) {
      found = true;
      results.push(
        result(
          "fail",
          `Migrations: ${join(config.migrations, file)} uses the unsupported Drizzle 0.x flat SQL layout; upgrade to Drizzle 1.0 with <migrations>/<timestamp>_<name>/migration.sql.`,
        ),
      );
    }
  }
  const migrations = existsSync(migrationsDirectory)
    ? files.scan({ cwd: migrationsDirectory, onlyFiles: true })
    : [];
  for await (const relative of migrations) {
    const file = join(config.migrations, relative);
    if (old.has(`${git.output.trim()}${dirname(file)}`)) continue;
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
  // Same positions, but quoted identifiers keep their text so constraint
  // names can be compared.
  const named = sql.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"/g,
    (match) => (match.startsWith('"') ? match : match.replace(/[^\n]/g, " ")),
  );
  const issues: Issue[] = [];
  let offset = 0;
  for (const statement of clean.split(";")) {
    const original = named.slice(offset, offset + statement.length);
    const start = offset + statement.search(/\S|$/);
    const line = clean.slice(0, start).split("\n").length;
    offset += statement.length + 1;
    const add = (status: Result["status"], message: string) =>
      issues.push({ status, message, line });
    if (/\bDROP\b/i.test(statement)) {
      if (rebuildsCheck(statement, original))
        add(
          "warn",
          "DROP CONSTRAINT re-added as CHECK in the same statement is accepted as expand; make sure the new CHECK only widens (the doctor cannot prove it).",
        );
      else
        add("fail", "remove DROP and perform the removal in a later deploy.");
    }
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

const IDENT = `"(?:""|[^"])*"|[A-Za-z_][\\w$]*`;
const constraintName = (raw: string) =>
  raw.startsWith('"')
    ? raw.slice(1, -1).replaceAll('""', '"')
    : raw.toLowerCase();

// True when every DROP in an ALTER TABLE statement is a
// `DROP CONSTRAINT x` followed, in the same statement, by
// `ADD CONSTRAINT x CHECK (...)` with the same name. `masked` hides quoted
// identifiers; `named` has the same positions with their text intact.
function rebuildsCheck(maskedSql: string, namedSql: string): boolean {
  // Dollar-quoted literals can hold parentheses or commas; blank them (keeping
  // positions) so they cannot hide the real action boundaries.
  const blank = (text: string) =>
    text.replace(/(?<![\w$])\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g, (match) =>
      match.replace(/[^\n]/g, " "),
    );
  const masked = blank(maskedSql);
  const named = blank(namedSql);
  const head = new RegExp(
    `^\\s*ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?(?:${IDENT})(?:\\s*\\.\\s*(?:${IDENT}))?\\s+`,
    "i",
  ).exec(masked);
  if (!head) return false;
  const actions: string[] = [];
  let depth = 0;
  let from = head[0].length;
  for (let i = from; i <= masked.length; i++) {
    const char = masked[i];
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (i === masked.length || (char === "," && depth === 0)) {
      actions.push(named.slice(from, i));
      from = i + 1;
    }
  }
  const drop = new RegExp(`^\\s*DROP\\s+CONSTRAINT\\s+(${IDENT})\\s*$`, "i");
  const add = new RegExp(
    `^\\s*ADD\\s+CONSTRAINT\\s+(${IDENT})\\s+CHECK\\s*\\(`,
    "i",
  );
  const dropped = new Set<string>();
  let sawDrop = false;
  for (const action of actions) {
    const added = add.exec(action);
    if (added) {
      dropped.delete(constraintName(added[1] as string));
      continue;
    }
    const removed = drop.exec(action);
    if (removed) {
      sawDrop = true;
      dropped.add(constraintName(removed[1] as string));
    } else if (/\bDROP\b/i.test(action)) return false;
  }
  return sawDrop && dropped.size === 0;
}

import { resolve } from "node:path";
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
      result(
        "fail",
        `Config do Produto: corrija dangus.config.ts: ${String(error)}`,
      ),
    ];
  }
  const results: Result[] = [];
  if (config.apps.api) {
    const path = resolve(directory, "apps/api/index.ts");
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
          ? "Integração do SDK na API presente."
          : `API: em apps/api/index.ts, importe observability e ${migration} de @dangus-box/server e execute ambos antes de .listen().`,
      ),
    );
  } else results.push(result("pass", "Integração do SDK: Produto sem API."));
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
    results.push(result("pass", `Versão do CLI fixada em bun.lock: ${spec}.`));
  } catch {
    results.push(
      result(
        "fail",
        "CLI: fixe uma versão publicada com bun add --dev --exact @dangus-box/cli@<versão> e inclua bun.lock no repositório.",
      ),
    );
  }
  const tailscale = await runner(["tailscale", "status"], directory);
  results.push(
    result(
      tailscale.code === 0 ? "pass" : "fail",
      tailscale.code === 0
        ? "Tailscale conectado."
        : "Tailscale: instale e conecte o Tailscale; confirme com tailscale status.",
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
        `Migrations: disponibilize a ref Git ${base} (por exemplo, git fetch origin main) ou informe --base <ref>.`,
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
      `${git.output.trim()}drizzle`,
    ],
    directory,
  );
  if (existing.code) {
    results.push(
      result(
        "fail",
        `Migrations: não foi possível ler ${base}; verifique a ref Git.`,
      ),
    );
    return results;
  }
  const old = new Set(existing.output.split("\0"));
  const files = new Bun.Glob("drizzle/**/*.sql");
  let found = false;
  for await (const file of files.scan({ cwd: directory, onlyFiles: true })) {
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
  if (!found) results.push(result("pass", "Migrations novas são aditivas."));
  return results;
}

export function lintSql(sql: string): Issue[] {
  // Oculta comentários, literais e identificadores entre aspas preservando as
  // posições; corpos $$ (blocos DO) continuam analisados porque executam SQL.
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
      add("fail", "remova DROP e faça a remoção em um deploy posterior.");
    if (/\bRENAME\b/i.test(statement))
      add(
        "fail",
        "substitua RENAME por uma migration aditiva em dois deploys.",
      );
    if (
      /\bALTER\s+(?:COLUMN\s+)?\S+\s+(?:SET\s+DATA\s+)?TYPE\b/i.test(statement)
    )
      add(
        "warn",
        "evite ALTER COLUMN TYPE; planeje a mudança sem bloquear a tabela.",
      );
    if (/\bSET\s+NOT\s+NULL\b/i.test(statement))
      add(
        "warn",
        "evite SET NOT NULL; planeje a validação sem bloquear a tabela.",
      );
    if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?!CONCURRENTLY\b)/i.test(statement))
      add(
        "warn",
        "use CREATE INDEX CONCURRENTLY para evitar bloquear a tabela.",
      );
  }
  return issues;
}

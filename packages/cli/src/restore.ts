import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ResolvedProductConfig } from "./config";

export type RestoreOptions = {
  from?: string;
  target?: string;
  yes?: boolean;
  verify?: boolean;
};

export function parseRestoreArgs(args: string[]): RestoreOptions {
  const options: RestoreOptions = {};
  while (args.length) {
    const arg = args.shift();
    if (arg === "--yes" && !options.yes) options.yes = true;
    else if (arg === "--verify" && !options.verify) options.verify = true;
    else if (
      (arg === "--from" || arg === "--target") &&
      args[0] &&
      !args[0].startsWith("--")
    ) {
      const key = arg === "--from" ? "from" : "target";
      if (options[key]) throw new Error("Opção repetida.");
      options[key] = args.shift();
    } else
      throw new Error(
        "Uso: dangus db restore [--from <object-key>] [--target <DATABASE_URL|caminho>] [--yes] [--verify]",
      );
  }
  if (options.verify && options.target)
    throw new Error("A Verificação de Restore exige destino descartável.");
  return options;
}

async function command(
  args: string[],
  input?: string | Uint8Array,
  env = process.env,
): Promise<string> {
  const child = Bun.spawn(args, {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  if (input !== undefined && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(`Falha em ${args[0]}: ${err.trim()}`);
  return out;
}

const unescapeXml = (s: string) =>
  s.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (entity) => {
    const map: Record<string, string> = {
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
      "&quot;": '"',
      "&apos;": "'",
    };
    return (
      map[entity] ??
      String.fromCodePoint(
        entity[2] === "x"
          ? Number.parseInt(entity.slice(3, -1), 16)
          : Number.parseInt(entity.slice(2, -1), 10),
      )
    );
  });
export function latestKey(xml: string, prefix: string): string | undefined {
  return [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)]
    .map((m) => unescapeXml(m[1]))
    .filter((key) => key.startsWith(prefix))
    .sort()
    .at(-1);
}
const quote = (value: string) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export async function restore(
  config: ResolvedProductConfig,
  options: RestoreOptions,
): Promise<void> {
  if (options.target && !options.yes) {
    process.stdout.write("Restaurar no destino informado? [s/N] ");
    // Sem resposta (stdin fechado) conta como não, em vez de travar.
    const prompt = createInterface({ input: process.stdin });
    const answer = await prompt[Symbol.asyncIterator]().next();
    prompt.close();
    if (answer.done || !/^(s|sim)$/i.test(answer.value.trim()))
      throw new Error("Restore cancelado.");
  }
  const prefix = `daily/${config.name}/produto/`;
  if (
    options.from &&
    !new RegExp(
      `^(daily|weekly|monthly)/${config.name}/produto/(?!\\.\\.?$)[^/]+$`,
    ).test(options.from)
  )
    throw new Error(`Backup ${options.from} fora do Produto ${config.name}.`);
  const entries = JSON.parse(await command(["bws", "secret", "list"])) as {
    key: string;
    value: string;
  }[];
  const secret = (key: string) => {
    const matches = entries.filter((item) => item.key === key);
    if (matches.length !== 1 || !matches[0].value)
      throw new Error(`Secret ${key} ausente ou duplicado no BWS.`);
    return matches[0].value;
  };
  const health = options.verify
    ? secret(`${config.name}__HEALTHCHECKS_RESTORE_URL`).replace(/\/$/, "")
    : undefined;
  const ping = async (suffix: string) => {
    if (health)
      await command(
        [
          "curl",
          "--fail",
          "--silent",
          "--show-error",
          "--max-time",
          "10",
          "--config",
          "-",
        ],
        `url = ${quote(health + suffix)}\n`,
      );
  };
  await ping("/start").catch(() => {});
  let dir = "";
  let container = "";
  // Ctrl-C ou SIGTERM não deixam o dump em texto nem o container para trás.
  const abort = () => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (container) Bun.spawnSync(["docker", "rm", "-f", container]);
    process.exit(130);
  };
  process.once("SIGINT", abort).once("SIGTERM", abort);
  try {
    const identity = secret("ops__BACKUP_AGE_PRIVATE_KEY");
    const endpoint = secret("platform__R2_ENDPOINT").replace(/\/$/, "");
    const access = secret("ops__R2_BACKUP_ACCESS_KEY_ID");
    const password = secret("ops__R2_BACKUP_SECRET_ACCESS_KEY");
    const curl = (url: string, output?: string) =>
      command(
        [
          "curl",
          "--fail",
          "--silent",
          "--show-error",
          "--aws-sigv4",
          "aws:amz:auto:s3",
          "--config",
          "-",
          ...(output ? ["--output", output] : []),
        ],
        `user = ${quote(`${access}:${password}`)}\nurl = ${quote(url)}\n`,
      );
    let key = options.from;
    if (!key) {
      let token = "";
      do {
        const query = new URLSearchParams({
          "list-type": "2",
          prefix,
          ...(token ? { "continuation-token": token } : {}),
        });
        const xml = await curl(`${endpoint}/dangus-backups?${query}`);
        const candidate = latestKey(xml, prefix);
        if (candidate && (!key || candidate > key)) key = candidate;
        token = unescapeXml(
          xml.match(
            /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/,
          )?.[1] ?? "",
        );
      } while (token);
    }
    if (!key) throw new Error("Nenhum Backup diário encontrado.");
    dir = await mkdtemp(join(tmpdir(), "dangus-restore-"));
    const encrypted = join(dir, "backup.age");
    const data = join(dir, "data");
    await curl(
      `${endpoint}/dangus-backups/${key.split("/").map(encodeURIComponent).join("/")}`,
      encrypted,
    );
    // A identidade vai pelo stdin: a chave privada nunca é gravada em disco.
    await command(
      ["age", "-d", "-i", "-", "-o", join(dir, "backup.gz"), encrypted],
      identity,
    );
    const decompressed = Bun.spawn(["gzip", "-dc", join(dir, "backup.gz")], {
      stdout: Bun.file(data),
      stderr: "pipe",
    });
    const gzipError = await new Response(decompressed.stderr).text();
    if (await decompressed.exited)
      throw new Error(`Falha ao descomprimir Backup: ${gzipError}`);
    if (config.database === "sqlite") {
      const db = new Database(data, { readonly: true, strict: true });
      try {
        if (
          db
            .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
            .get()?.integrity_check !== "ok"
        )
          throw new Error("integrity_check falhou.");
      } finally {
        db.close();
      }
      if (options.target) {
        // Um -wal antigo seria reaplicado sobre o banco restaurado.
        if (existsSync(`${options.target}-wal`))
          throw new Error("Pare a App: o destino SQLite está em uso.");
        await Bun.write(options.target, Bun.file(data));
      }
    } else {
      const sql = await Bun.file(data).text();
      if (options.target) {
        // libpq não lê URL em PGDATABASE; a senha sai do argv e vai pelo ambiente.
        const url = new URL(options.target);
        const password = decodeURIComponent(url.password);
        url.password = "";
        await command(
          ["psql", "-v", "ON_ERROR_STOP=1", "-1", "-d", url.href],
          sql,
          { ...process.env, PGPASSWORD: password },
        );
      } else {
        container = `dangus-restore-${crypto.randomUUID()}`;
        await command([
          "docker",
          "run",
          "-d",
          "--name",
          container,
          "-e",
          "POSTGRES_HOST_AUTH_METHOD=trust",
          "postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929",
        ]);
        let ready = false;
        for (let i = 0; i < 60; i++) {
          try {
            await command([
              "docker",
              "exec",
              container,
              "pg_isready",
              "-U",
              "postgres",
            ]);
            ready = true;
            break;
          } catch {
            await Bun.sleep(1000);
          }
        }
        if (!ready) throw new Error("Postgres descartável não iniciou.");
        await command(
          [
            "docker",
            "exec",
            "-i",
            container,
            "psql",
            "-U",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            "-1",
          ],
          sql,
        );
        const schema = await command([
          "docker",
          "exec",
          container,
          "psql",
          "-U",
          "postgres",
          "-tAc",
          "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')",
        ]);
        if (Number(schema.trim()) < 1)
          throw new Error("Restore sem tabelas no schema.");
      }
    }
    await ping("");
    console.log(`Backup ${key} restaurado e verificado.`);
  } catch (error) {
    await ping("/fail").catch(() => {});
    throw error;
  } finally {
    process.off("SIGINT", abort).off("SIGTERM", abort);
    if (container)
      await command(["docker", "rm", "-f", container]).catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

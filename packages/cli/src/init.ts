import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { version } from "../package.json";

const apps = ["api", "web", "mobile"] as const;
type App = (typeof apps)[number];
const secrets: Record<App, string[]> = {
  api: ["UNLEASH_TOKEN", "UMAMI_WEBSITE_ID"],
  web: ["UMAMI_WEBSITE_ID", "FLAGS_FRONTEND_TOKEN"],
  mobile: ["EXPO_PUBLIC_UMAMI_WEBSITE_ID", "EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN"],
};
const image =
  "oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598";

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function init(root: string, yes: boolean) {
  const found: App[] = [];
  for (const app of apps)
    if (await exists(join(root, "apps", app))) found.push(app);
  if (!found.length)
    throw new Error(
      "Nenhuma App encontrada em apps/api, apps/web ou apps/mobile.",
    );
  const drizzlePath = join(root, "drizzle.config.ts");
  if (!(await exists(drizzlePath)))
    throw new Error("drizzle.config.ts não encontrado na raiz do Produto.");
  const drizzle = await readFile(drizzlePath, "utf8");
  const matches = [
    ...drizzle.matchAll(/\bdialect\s*:\s*["'](sqlite|postgresql)["']/g),
  ];
  if (matches.length !== 1)
    throw new Error(
      "Não foi possível detectar o dialect sqlite ou postgresql em drizzle.config.ts.",
    );
  const database = matches[0][1] === "postgresql" ? "postgres" : "sqlite";
  const name =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "produto";
  // O iterador guarda as linhas já lidas: respostas por pipe não se perdem.
  const rl = yes ? undefined : createInterface({ input: process.stdin });
  const answers = rl?.[Symbol.asyncIterator]();
  const confirm = async (question: string) => {
    if (!answers) return false;
    process.stdout.write(`${question} [s/N] `);
    const answer = await answers.next();
    return !answer.done && /^(s|sim)$/i.test(answer.value.trim());
  };
  try {
    console.log(`Apps: ${found.join(", ")}; Banco do Produto: ${database}.`);
    if (!yes && !(await confirm("Confirmar Adoção?"))) {
      console.log("Adoção cancelada.");
      return;
    }
    // Mesmo formato do Biome e do Prettier: o arquivo formatado continua idêntico ao gerado.
    const secretList = (app: App) => {
      const line = `      secrets: [${secrets[app].map((secret) => `"${secret}"`).join(", ")}],`;
      if (line.length <= 80) return line;
      return `      secrets: [\n${secrets[app].map((secret) => `        "${secret}",\n`).join("")}      ],`;
    };
    const configApps = found
      .map(
        (app) =>
          `    ${app}: {\n      domain: "${app}.${name}.com",\n${secretList(app)}\n    },`,
      )
      .join("\n");
    const config = `import { defineConfig } from "@dangus-box/cli";\n\nexport default defineConfig({\n  name: "${name}",\n  apps: {\n${configApps}\n  },\n  database: "${database}",\n  deployTimeoutSeconds: 120,\n});\n`;
    const docker = (app: "api" | "web") =>
      `FROM ${image}\nWORKDIR /workspace\nCOPY . ./\nRUN bun install --frozen-lockfile\n${app === "web" ? "RUN bun run --bun vite build --config apps/web/vite.config.ts\nENV PORT=3000\n" : ""}EXPOSE 3000\nCMD ["bun", "run", "apps/${app}/${app === "api" ? "index.ts" : "server.ts"}"]\n`;
    // A Verificação de Restore será adicionada a esta lista pela issue #23.
    const files: [string, string][] = [
      ["dangus.config.ts", config],
      [
        ".github/workflows/deploy.yml",
        await readFile(
          join(import.meta.dir, "../templates/deploy.yml"),
          "utf8",
        ),
      ],
    ];
    for (const app of ["api", "web"] as const)
      if (found.includes(app))
        files.push([`apps/${app}/Dockerfile`, docker(app)]);
    // O contexto do build é a raiz do Produto: segredos e dados locais ficam fora das imagens.
    if (found.includes("api") || found.includes("web"))
      files.push([
        ".dockerignore",
        ".git\n.dangus\n**/node_modules\n**/.env\n**/.env.*\n**/*.sqlite*\n",
      ]);
    for (const [path, content] of files) {
      const target = join(root, path);
      if (await exists(target)) {
        if ((await readFile(target, "utf8")) === content) {
          console.log(`${path}: já está atualizado.`);
          continue;
        }
        if (!(await confirm(`Sobrescrever ${path}?`))) {
          console.log(`${path}: preservado.`);
          continue;
        }
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      console.log(`${path}: gerado.`);
    }
    const ignorePath = join(root, ".gitignore");
    const ignore = (await exists(ignorePath))
      ? await readFile(ignorePath, "utf8")
      : "";
    if (!ignore.split(/\r?\n/).some((line) => line.trim() === ".dangus/")) {
      await writeFile(
        ignorePath,
        `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}.dangus/\n`,
      );
      console.log(".gitignore: .dangus/ incluído.");
    }
    const deps = [
      `@dangus-box/cli@${version}`,
      ...found.map(
        (app) =>
          `@dangus-box/${app === "api" ? "server" : app === "mobile" ? "native" : "web"}@${version}`,
      ),
      ...(found.includes("api") ? ["@openfeature/server-sdk@1.23.0"] : []),
    ];
    const child = Bun.spawn(["bun", "add", "--exact", ...deps], {
      cwd: root,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await child.exited) !== 0)
      throw new Error("Falha ao instalar as dependências do SDK.");
    console.log(
      "Revise os domínios em dangus.config.ts e aplique as integrações:",
    );
    if (found.includes("api"))
      console.log(`API (apps/api/index.ts):
import { observability, ${database === "sqlite" ? "migrateSqlite" : "migratePostgres"}, configureFlags, trackEvent } from "@dangus-box/server";
import { OpenFeature } from "@openfeature/server-sdk";
const observacao = observability();
${database === "sqlite" ? 'migrateSqlite(sqlite, "./drizzle");' : 'await migratePostgres(databaseUrl, "./drizzle");'}
await configureFlags("${name}");
// Adicione .use(observacao.plugin) ao Elysia e chame observacao.markReady() após o boot.
// Avalie Flags com OpenFeature.getClient() e envie eventos com trackEvent(...).`);
    if (found.includes("web"))
      console.log(`Web (raiz React):
import { Analytics, Flags } from "@dangus-box/web";
// Passe UMAMI_WEBSITE_ID e FLAGS_FRONTEND_TOKEN pelo loader do servidor:
<Analytics websiteId={websiteId} />
<Flags token={token} appName="${name}"><Outlet /></Flags>
// No servidor, antes das demais rotas:
import { proxyAnalytics } from "@dangus-box/web/server";
const proxy = await proxyAnalytics(request, { websiteId: process.env.UMAMI_WEBSITE_ID });
if (proxy) return proxy;`);
    if (found.includes("mobile"))
      console.log(`Mobile:
import { configurarFlags, enviarEvento, OpenFeature, OpenFeatureProvider } from "@dangus-box/native";
await configurarFlags("${name}", undefined, process.env.EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN);
<OpenFeatureProvider client={OpenFeature.getClient()}>{/* App */}</OpenFeatureProvider>
await enviarEvento("evento", undefined, undefined, process.env.EXPO_PUBLIC_UMAMI_WEBSITE_ID);`);
    console.log(
      "Para concluir a Adoção, conecte o Tailscale e execute `dangus register` para o Registro na Stack Ops.",
    );
  } finally {
    rl?.close();
  }
}

import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadConfig } from "./config";

const cli = join(import.meta.dir, "index.ts");
const packages = join(import.meta.dir, "../..");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function product(
  apps: string[],
  drizzle: string | null = 'export default { dialect: "sqlite" };\n',
) {
  const root = await mkdtemp(join(tmpdir(), "produto-"));
  roots.push(root);
  for (const app of apps) {
    await mkdir(join(root, "apps", app), { recursive: true });
    await writeFile(join(root, "apps", app, "index.ts"), `// ${app}\n`);
  }
  if (drizzle !== null)
    await writeFile(join(root, "drizzle.config.ts"), drizzle);
  // bun falso: registra o `bun add` sem acessar o npm.
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "bun"),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$PWD/bun-args"\n',
  );
  await chmod(join(bin, "bun"), 0o755);
  const run = async (args: string[], stdin = "") => {
    const child = Bun.spawn([process.execPath, cli, "init", ...args], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdin: new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: await child.exited,
      output: await new Response(child.stdout).text(),
      error: await new Response(child.stderr).text(),
    };
  };
  const read = (path: string) => readFile(join(root, path), "utf8");
  const list = async () =>
    (await readdir(root, { recursive: true }))
      .filter((path) => !path.startsWith("bin"))
      .sort();
  return { root, run, read, list };
}

test("detecta Apps e banco, gera arquivos e preserva edições com --yes", async () => {
  const { root, run, read } = await product(["api", "web", "mobile"]);
  const first = await run(["--yes"]);
  expect(first.code).toBe(0);
  expect(first.output).toContain(
    "Apps: api, web, mobile; Banco do Produto: sqlite",
  );
  expect(first.output).toContain("observacao.markReady()");
  expect(first.output).toContain("execute `dangus register`");
  expect(first.output).toContain(
    `await configureFlags("${basename(root).toLowerCase()}")`,
  );
  expect(first.output).toContain(`appName="${basename(root).toLowerCase()}"`);
  expect(await read("dangus.config.ts")).toContain(
    '"EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN"',
  );
  expect(await read(".gitignore")).toBe(".dangus/\n");
  expect(await read("bun-args")).toContain("@dangus-box/server@0.0.0");
  expect(await read(".github/workflows/deploy.yml")).toBe(
    await readFile(join(import.meta.dir, "../templates/deploy.yml"), "utf8"),
  );
  await writeFile(join(root, "apps/api/Dockerfile"), "editado\n");
  const second = await run(["--yes"]);
  expect(second.code).toBe(0);
  expect(second.output).toContain("apps/api/Dockerfile: preservado.");
  expect(second.output).toContain("dangus.config.ts: já está atualizado.");
  expect(await read("apps/api/Dockerfile")).toBe("editado\n");
  expect(await read(".gitignore")).toBe(".dangus/\n");
});

test("sem confirmação interativa, nada é gerado nem instalado", async () => {
  const { run, list } = await product(["api"]);
  const before = await list();
  const result = await run([], "n\n");
  expect(result.code).toBe(0);
  expect(result.output).toContain("Confirmar Adoção? [s/N] Adoção cancelada.");
  expect(await list()).toEqual(before);
});

test("segunda execução interativa pergunta antes de sobrescrever cada arquivo editado", async () => {
  const { root, run, read } = await product(["api"]);
  expect((await run([], "s\n")).code).toBe(0);
  const dockerfile = await read("apps/api/Dockerfile");
  await writeFile(join(root, "dangus.config.ts"), "editado\n");
  await writeFile(join(root, "apps/api/Dockerfile"), "editado\n");
  // Respostas por pipe chegam de uma vez: confirma, sobrescreve a Config, preserva o Dockerfile.
  const second = await run([], "s\ns\nn\n");
  expect(second.code).toBe(0);
  expect(second.output).toContain("Sobrescrever dangus.config.ts? [s/N]");
  expect(second.output).toContain("Sobrescrever apps/api/Dockerfile? [s/N]");
  expect(await read("dangus.config.ts")).not.toBe("editado\n");
  expect(await read("apps/api/Dockerfile")).toBe("editado\n");
  // Sem resposta (fim da entrada) também preserva.
  const third = await run([], "s\n");
  expect(third.code).toBe(0);
  expect(await read("apps/api/Dockerfile")).toBe("editado\n");
  expect(dockerfile).not.toBe("editado\n");
});

test("não edita o código das Apps", async () => {
  const { run, read } = await product(["api", "web", "mobile"]);
  expect((await run(["--yes"])).code).toBe(0);
  for (const app of ["api", "web", "mobile"])
    expect(await read(`apps/${app}/index.ts`)).toBe(`// ${app}\n`);
});

test("Postgres só com web gera apenas o que a App usa", async () => {
  const { run, read, list } = await product(
    ["web"],
    "export default defineConfig({ dialect: 'postgresql' });\n",
  );
  const result = await run(["--yes"]);
  expect(result.code).toBe(0);
  expect(result.output).toContain("Apps: web; Banco do Produto: postgres");
  expect(await read("dangus.config.ts")).toContain('database: "postgres"');
  expect(await list()).not.toContain("apps/api/Dockerfile");
  expect(await read("bun-args")).not.toContain("@dangus-box/server");
  expect(await read("bun-args")).toContain("@dangus-box/web@");
  expect(result.output).not.toContain("API (apps/api/index.ts)");
});

test("só mobile não gera Dockerfiles nem .dockerignore", async () => {
  const { run, list } = await product(["mobile"]);
  expect((await run(["--yes"])).code).toBe(0);
  const files = await list();
  expect(files).toContain("dangus.config.ts");
  expect(files.filter((path) => path.includes("ocker"))).toEqual([]);
});

test("contexto de build da raiz exclui segredos, dependências e dados locais", async () => {
  const { run, read } = await product(["api"]);
  expect((await run(["--yes"])).code).toBe(0);
  const ignore = (await read(".dockerignore")).split("\n");
  for (const pattern of [
    ".git",
    ".dangus",
    "**/node_modules",
    "**/.env",
    "**/.env.*",
    "**/*.sqlite*",
  ])
    expect(ignore).toContain(pattern);
});

for (const [caso, drizzle, apps, mensagem] of [
  ["sem Apps", 'export default { dialect: "sqlite" };\n', [], "Nenhuma App"],
  ["sem drizzle.config.ts", null, ["api"], "drizzle.config.ts não"],
  [
    "dialect mysql",
    'export default { dialect: "mysql" };\n',
    ["api"],
    "dialect sqlite ou postgresql",
  ],
  [
    "dois dialects",
    'const a = { dialect: "sqlite" }; const b = { dialect: "postgresql" };\n',
    ["api"],
    "dialect sqlite ou postgresql",
  ],
] as const)
  test(`falha sem gerar arquivos: ${caso}`, async () => {
    const { run, list } = await product([...apps], drizzle);
    const before = await list();
    const result = await run(["--yes"]);
    expect(result.code).toBe(1);
    expect(result.error).toContain(mensagem);
    expect(result.error).not.toContain("ENOENT");
    expect(await list()).toEqual(before);
  });

test("instala as versões publicadas junto com o CLI", async () => {
  const pkg = async (name: string) =>
    JSON.parse(await readFile(join(packages, name, "package.json"), "utf8"));
  const cliVersion = (await pkg("cli")).version;
  for (const name of ["server", "web", "native"])
    expect((await pkg(name)).version).toBe(cliVersion);
  const { run, read } = await product(["api"]);
  expect((await run(["--yes"])).code).toBe(0);
  expect(await read("bun-args")).toContain(
    `@openfeature/server-sdk@${(await pkg("server")).dependencies["@openfeature/server-sdk"]}`,
  );
});

test("Config gerada é válida e já está no formato do Biome", async () => {
  const { root, run, read } = await product(["api", "web", "mobile"]);
  expect((await run(["--yes"])).code).toBe(0);
  await mkdir(join(root, "node_modules/@dangus-box"), { recursive: true });
  await symlink(
    join(packages, "cli"),
    join(root, "node_modules/@dangus-box/cli"),
  );
  const config = await loadConfig(root);
  expect(config.database).toBe("sqlite");
  expect(config.apps.web?.secrets).toEqual([
    "UMAMI_WEBSITE_ID",
    "FLAGS_FRONTEND_TOKEN",
  ]);
  const generated = await read("dangus.config.ts");
  const biome = Bun.spawn(
    [
      join(packages, "../node_modules/.bin/biome"),
      "format",
      "--stdin-file-path=dangus.config.ts",
    ],
    { stdin: new TextEncoder().encode(generated), stdout: "pipe" },
  );
  expect(await new Response(biome.stdout).text()).toBe(generated);
});

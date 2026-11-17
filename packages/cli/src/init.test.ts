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
import { version } from "../package.json";
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
  // fake bun: records `bun add` without accessing npm.
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

test("detects Apps and database, generates files and preserves edits with --yes", async () => {
  const { root, run, read } = await product(["api", "web", "mobile"]);
  const first = await run(["--yes"]);
  expect(first.code).toBe(0);
  expect(first.output).toContain(
    "Apps: api, web, mobile; Product database: sqlite",
  );
  expect(first.output).toContain("observation.markReady()");
  expect(first.output).toContain("run `dangus register`");
  expect(first.output).toContain(
    `await configureFlags("${basename(root).toLowerCase()}")`,
  );
  expect(first.output).toContain(`appName="${basename(root).toLowerCase()}"`);
  expect(await read("dangus.config.ts")).toContain(
    '"EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN"',
  );
  expect(await read(".gitignore")).toBe(".dangus/\n");
  expect(await read("bun-args")).toContain(`@dangus-box/server@${version}`);
  expect(await read(".github/workflows/deploy.yml")).toBe(
    await readFile(join(import.meta.dir, "../templates/deploy.yml"), "utf8"),
  );
  expect(await read(".github/workflows/restore.yml")).toBe(
    await readFile(join(import.meta.dir, "../templates/restore.yml"), "utf8"),
  );
  await writeFile(join(root, ".github/workflows/restore.yml"), "edited\n");
  await writeFile(join(root, "apps/api/Dockerfile"), "edited\n");
  const second = await run(["--yes"]);
  expect(second.code).toBe(0);
  expect(second.output).toContain("apps/api/Dockerfile: preserved.");
  expect(await read(".github/workflows/restore.yml")).toBe("edited\n");
  expect(second.output).toContain("dangus.config.ts: already up to date.");
  expect(await read("apps/api/Dockerfile")).toBe("edited\n");
  expect(await read(".gitignore")).toBe(".dangus/\n");
});

test("without interactive confirmation, nothing is generated or installed", async () => {
  const { run, list } = await product(["api"]);
  const before = await list();
  const result = await run([], "n\n");
  expect(result.code).toBe(0);
  expect(result.output).toContain("Confirm Adoption? [s/N] Adoption canceled.");
  expect(await list()).toEqual(before);
});

test("second interactive run asks before overwriting each edited file", async () => {
  const { root, run, read } = await product(["api"]);
  expect((await run([], "s\n")).code).toBe(0);
  const dockerfile = await read("apps/api/Dockerfile");
  await writeFile(join(root, "dangus.config.ts"), "edited\n");
  await writeFile(join(root, "apps/api/Dockerfile"), "edited\n");
  // Piped answers arrive together: confirm, overwrite Config, preserve Dockerfile.
  const second = await run([], "s\ns\nn\n");
  expect(second.code).toBe(0);
  expect(second.output).toContain("Overwrite dangus.config.ts? [s/N]");
  expect(second.output).toContain("Overwrite apps/api/Dockerfile? [s/N]");
  expect(await read("dangus.config.ts")).not.toBe("edited\n");
  expect(await read("apps/api/Dockerfile")).toBe("edited\n");
  // No answer (end of input) also preserves the file.
  const third = await run([], "s\n");
  expect(third.code).toBe(0);
  expect(await read("apps/api/Dockerfile")).toBe("edited\n");
  expect(dockerfile).not.toBe("edited\n");
});

test("does not edit App code", async () => {
  const { run, read } = await product(["api", "web", "mobile"]);
  expect((await run(["--yes"])).code).toBe(0);
  for (const app of ["api", "web", "mobile"])
    expect(await read(`apps/${app}/index.ts`)).toBe(`// ${app}\n`);
});

test("Postgres with web only generates what the App uses", async () => {
  const { run, read, list } = await product(
    ["web"],
    "export default defineConfig({ dialect: 'postgresql' });\n",
  );
  const result = await run(["--yes"]);
  expect(result.code).toBe(0);
  expect(result.output).toContain("Apps: web; Product database: postgres");
  expect(await read("dangus.config.ts")).toContain('database: "postgres"');
  expect(await list()).not.toContain("apps/api/Dockerfile");
  expect(await read("bun-args")).not.toContain("@dangus-box/server");
  expect(await read("bun-args")).toContain("@dangus-box/web@");
  expect(result.output).not.toContain("API (apps/api/index.ts)");
});

test("mobile only generates no Dockerfiles or .dockerignore", async () => {
  const { run, list } = await product(["mobile"]);
  expect((await run(["--yes"])).code).toBe(0);
  const files = await list();
  expect(files).toContain("dangus.config.ts");
  expect(files.filter((path) => path.includes("ocker"))).toEqual([]);
});

test("root build context excludes secrets, dependencies and local data", async () => {
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

for (const [scenario, drizzle, apps, message] of [
  ["without Apps", 'export default { dialect: "sqlite" };\n', [], "No App"],
  ["without drizzle.config.ts", null, ["api"], "drizzle.config.ts not"],
  [
    "dialect mysql",
    'export default { dialect: "mysql" };\n',
    ["api"],
    "sqlite or postgresql dialect",
  ],
  [
    "two dialects",
    'const a = { dialect: "sqlite" }; const b = { dialect: "postgresql" };\n',
    ["api"],
    "sqlite or postgresql dialect",
  ],
] as const)
  test(`fails without generating files: ${scenario}`, async () => {
    const { run, list } = await product([...apps], drizzle);
    const before = await list();
    const result = await run(["--yes"]);
    expect(result.code).toBe(1);
    expect(result.error).toContain(message);
    expect(result.error).not.toContain("ENOENT");
    expect(await list()).toEqual(before);
  });

test("installs published versions alongside the CLI", async () => {
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

test("generated Config is valid and already formatted by Biome", async () => {
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

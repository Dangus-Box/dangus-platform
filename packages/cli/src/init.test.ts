import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "index.ts");

test("detecta Apps e banco, gera arquivos e preserva edições com --yes", async () => {
  const root = await mkdtemp(join(tmpdir(), "produto-"));
  try {
    for (const app of ["api", "web", "mobile"])
      await mkdir(join(root, "apps", app), { recursive: true });
    await writeFile(
      join(root, "drizzle.config.ts"),
      'export default { dialect: "sqlite" };\n',
    );
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "bun"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$PWD/bun-args"\n',
    );
    await chmod(join(bin, "bun"), 0o755);
    const run = async () => {
      const child = Bun.spawn([process.execPath, cli, "init", "--yes"], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: await child.exited,
        output: await new Response(child.stdout).text(),
      };
    };
    const first = await run();
    expect(first.code).toBe(0);
    expect(first.output).toContain(
      "Apps: api, web, mobile; Banco do Produto: sqlite",
    );
    expect(first.output).toContain("observacao.markReady()");
    expect(await readFile(join(root, "dangus.config.ts"), "utf8")).toContain(
      '"EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN"',
    );
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(".dangus/\n");
    expect(await readFile(join(root, "bun-args"), "utf8")).toContain(
      "@dangus-box/server@0.0.0",
    );
    expect(
      await readFile(join(root, ".github/workflows/deploy.yml"), "utf8"),
    ).toBe(
      await readFile(join(import.meta.dir, "../templates/deploy.yml"), "utf8"),
    );
    await writeFile(join(root, "apps/api/Dockerfile"), "editado\n");
    const second = await run();
    expect(second.code).toBe(0);
    expect(second.output).toContain("apps/api/Dockerfile: preservado.");
    expect(await readFile(join(root, "apps/api/Dockerfile"), "utf8")).toBe(
      "editado\n",
    );
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe(".dangus/\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

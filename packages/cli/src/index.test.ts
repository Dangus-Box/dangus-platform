import { expect, test } from "bun:test";
import { join } from "node:path";
import { version } from "../package.json";

const workspaceBin = join(import.meta.dir, "../../../node_modules/.bin/dangus");

test("exibe a versão do CLI pelo bin do workspace", async () => {
  const result = Bun.spawn([workspaceBin, "--version"], { stdout: "pipe" });
  expect(await new Response(result.stdout).text()).toBe(`${version}\n`);
  expect(await result.exited).toBe(0);
});

test("monta a invocação SSH do Host", async () => {
  const { sshCommand } = await import("./bootstrap");
  expect(sshCommand("root@host.example")).toEqual([
    "ssh",
    "-T",
    "--",
    "root@host.example",
    "sudo",
    "bash",
    "-s",
  ]);
});

test("rejeita Host com opções ou metacaracteres", async () => {
  const { sshCommand } = await import("./bootstrap");
  for (const host of [
    "",
    "-oProxyCommand=x",
    "host;id",
    "root@host name",
    "root@host\ncommand",
  ]) {
    expect(() => sshCommand(host)).toThrow("Host inválido.");
  }
});

test("obtém a chave do BWS e envia o script por SSH sem incluí-la nos argumentos", async () => {
  const { mkdtemp, readFile, writeFile, chmod, rm } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "dangus-cli-"));
  try {
    const fakeKey = "tskey-auth-teste-nao-e-um-segredo";
    await writeFile(
      join(dir, "bws"),
      `#!/bin/sh\nprintf '%s' '{"value":"${fakeKey}"}'\n`,
    );
    await writeFile(
      join(dir, "ssh"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args'\ncat > '${dir}/stdin'\n`,
    );
    await chmod(join(dir, "bws"), 0o755);
    await chmod(join(dir, "ssh"), 0o755);
    const process = Bun.spawn(
      [workspaceBin, "host", "bootstrap", "root@host"],
      {
        env: {
          ...Bun.env,
          PATH: `${dir}:${Bun.env.PATH}`,
          DANGUS_TAILSCALE_BWS_SECRET_ID:
            "00000000-0000-0000-0000-000000000000",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await process.exited).toBe(0);
    const args = await readFile(join(dir, "args"), "utf8");
    const input = await readFile(join(dir, "stdin"), "utf8");
    expect(args).toBe("-T\n--\nroot@host\nsudo\nbash\n-s\n");
    expect(args).not.toContain(fakeKey);
    expect(input).toContain(`DANGUS_TAILSCALE_AUTH_KEY='${fakeKey}'`);
    expect(input).toContain("Provisionamento concluído");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

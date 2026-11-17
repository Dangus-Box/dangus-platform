import { expect, test } from "bun:test";
import { join } from "node:path";

const workspaceBin = join(import.meta.dir, "../../../node_modules/.bin/dangus");

test("displays the CLI version through the workspace bin", async () => {
  const result = Bun.spawn([workspaceBin, "--version"], { stdout: "pipe" });
  expect(await new Response(result.stdout).text()).toBe("0.0.0\n");
  expect(await result.exited).toBe(0);
});

test("builds the Host SSH invocation", async () => {
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

test("rejects a Host with options or metacharacters", async () => {
  const { sshCommand } = await import("./bootstrap");
  for (const host of [
    "",
    "-oProxyCommand=x",
    "host;id",
    "root@host name",
    "root@host\ncommand",
  ]) {
    expect(() => sshCommand(host)).toThrow("Invalid Host.");
  }
});

test("gets the BWS key and sends the script over SSH without including it in arguments", async () => {
  const { mkdtemp, readFile, writeFile, chmod, rm } = await import(
    "node:fs/promises"
  );
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "dangus-cli-"));
  try {
    const fakeKey = "tskey-auth-test-not-a-secret";
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
    expect(input).toContain("Provisioning complete");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

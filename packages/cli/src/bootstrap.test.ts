import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sshCommand } from "./bootstrap";

const workspaceBin = join(import.meta.dir, "../../../node_modules/.bin/dangus");

test("rejects a Host that injects SSH options or commands", () => {
  for (const host of [
    "root@-oProxyCommand=x",
    "-l",
    "a@b@c",
    "host$(id)",
    "host`id`",
    "host|id",
    "host&&id",
    "root@host\tx",
  ]) {
    expect(() => sshCommand(host)).toThrow("Invalid Host.");
  }
});

async function runWithFakes(bws: string) {
  const dir = await mkdtemp(join(tmpdir(), "dangus-cli-"));
  await writeFile(join(dir, "bws"), `#!/bin/sh\n${bws}\n`);
  await writeFile(join(dir, "ssh"), `#!/bin/sh\ntouch '${dir}/ssh-called'\n`);
  await chmod(join(dir, "bws"), 0o755);
  await chmod(join(dir, "ssh"), 0o755);
  const child = Bun.spawn([workspaceBin, "host", "bootstrap", "root@host"], {
    env: {
      ...Bun.env,
      PATH: `${dir}:${Bun.env.PATH}`,
      DANGUS_TAILSCALE_BWS_SECRET_ID: "00000000-0000-0000-0000-000000000000",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await child.exited;
  const stderr = await new Response(child.stderr).text();
  const sshCalled = await readFile(join(dir, "ssh-called")).then(
    () => true,
    () => false,
  );
  await rm(dir, { recursive: true, force: true });
  return { code, stderr, sshCalled };
}

test("does not call SSH when BWS fails", async () => {
  const result = await runWithFakes("exit 1");
  expect(result.code).toBe(1);
  expect(result.sshCalled).toBe(false);
});

test("rejects a BWS key that would escape assignment in the remote shell", async () => {
  const result = await runWithFakes(
    `printf '%s' '{"value":"tskey-auth-x'"'"'; touch /pwned #"}'`,
  );
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Invalid Tailscale key in BWS.");
  expect(result.sshCalled).toBe(false);
});

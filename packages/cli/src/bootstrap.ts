export function sshCommand(host: string): string[] {
  if (
    !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9][a-zA-Z0-9.:-]*$/.test(host)
  ) {
    throw new Error("Host inválido.");
  }
  return ["ssh", "-T", "--", host, "sudo", "bash", "-s"];
}

export async function bootstrap(host: string): Promise<number> {
  const command = sshCommand(host);
  const id = process.env.DANGUS_TAILSCALE_BWS_SECRET_ID;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error(
      "Informe DANGUS_TAILSCALE_BWS_SECRET_ID com o ID do secret no BWS.",
    );
  }
  const bws = Bun.spawn(["bws", "secret", "get", id], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(bws.stdout).text();
  if ((await bws.exited) !== 0)
    throw new Error("Não foi possível obter o secret do BWS.");
  const secret: unknown = JSON.parse(output);
  if (
    !secret ||
    typeof secret !== "object" ||
    !("value" in secret) ||
    typeof secret.value !== "string" ||
    !/^tskey-auth-[a-zA-Z0-9-]+$/.test(secret.value)
  )
    throw new Error("Chave Tailscale inválida no BWS.");
  const script = await Bun.file(
    new URL("./bootstrap.sh", import.meta.url),
  ).text();
  const ssh = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  });
  ssh.stdin.write(`DANGUS_TAILSCALE_AUTH_KEY='${secret.value}'\n${script}`);
  ssh.stdin.end();
  return await ssh.exited;
}

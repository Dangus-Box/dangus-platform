import { type Runner, run } from "./deploy";

export async function listProducts(
  directory: string,
  runner: Runner = run,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const host = env.DANGUS_HOST || "dangus-host";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host))
    throw new Error("Host Tailscale inválido.");
  const result = await runner(
    [
      "ssh",
      "-T",
      "--",
      host,
      "docker",
      "ps",
      "--filter",
      "label=product",
      "--filter",
      "label=app",
      "--format",
      `'{{.Label "product"}}\\t{{.Label "app"}}'`,
    ],
    env,
    directory,
  );
  if (result.code !== 0) throw new Error("Falha ao listar Apps no Host.");
  const rows = new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      // O proxy da Plataforma e o Banco do Produto também têm labels; não são Apps.
      .filter((line) => /\t(api|web)$/.test(line)),
  );
  return ["PRODUTO\tAPP", ...[...rows].sort()].join("\n");
}

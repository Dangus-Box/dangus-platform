import { DEFAULT_HOST, type Runner, run } from "./deploy";

export async function listProducts(
  directory: string,
  runner: Runner = run,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const host = env.DANGUS_HOST || DEFAULT_HOST;
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
  if (result.code !== 0) {
    // Saída do Host: troca caracteres de controle do terminal por espaço e limita o tamanho.
    const reason = (result.stderr ?? "")
      .replace(/\p{Cc}+/gu, " ")
      .trim()
      .slice(0, 500);
    throw new Error(
      reason
        ? `Falha ao listar Apps no Host: ${reason}`
        : "Falha ao listar Apps no Host.",
    );
  }
  const rows = new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      // O proxy da Plataforma e o Banco do Produto também têm labels; não são Apps.
      .filter((line) => /\t(api|web)$/.test(line)),
  );
  return ["PRODUTO\tAPP", ...[...rows].sort()].join("\n");
}

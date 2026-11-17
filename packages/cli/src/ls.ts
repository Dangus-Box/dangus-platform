import { DEFAULT_HOST, type Runner, run } from "./deploy";

export async function listProducts(
  directory: string,
  runner: Runner = run,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const host = env.DANGUS_HOST || DEFAULT_HOST;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host))
    throw new Error("Invalid Tailscale Host.");
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
    // Host output: replace terminal control characters with spaces and limit length.
    const reason = (result.stderr ?? "")
      .replace(/\p{Cc}+/gu, " ")
      .trim()
      .slice(0, 500);
    throw new Error(
      reason
        ? `Failed to list Apps on the Host: ${reason}`
        : "Failed to list Apps on the Host.",
    );
  }
  const rows = new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      // The Platform proxy and Product database also have labels; they are not Apps.
      .filter((line) => /\t(api|web)$/.test(line)),
  );
  return ["PRODUTO\tAPP", ...[...rows].sort()].join("\n");
}

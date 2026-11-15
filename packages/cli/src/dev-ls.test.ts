import { expect, test } from "bun:test";
import { loadConfig } from "./config";
import type { Runner } from "./deploy";
import { dev } from "./dev";
import { listProducts } from "./ls";

for (const variant of ["sqlite", "postgres"]) {
  test(`dev executa ${variant} com ambiente local e apenas seu banco`, async () => {
    const config = await loadConfig(`examples/${variant}`);
    const calls: string[][] = [];
    const runner: Runner = async (args, env) => {
      calls.push(args);
      expect(env.NODE_ENV).toBe("development");
      expect(env.DANGUS_DEV).toBe("1");
      if (args[0] === "bun" && variant === "postgres")
        expect(env.DATABASE_URL).toBe(
          "postgres://produto:produto@localhost:55432/produto",
        );
      if (args[0] === "docker" && args.includes("up")) {
        const yaml = await Bun.file(args[args.indexOf("-f") + 1]).text();
        const doc = Bun.YAML.parse(yaml) as {
          services: Record<string, unknown>;
        };
        expect(Object.keys(doc.services)).toEqual(["postgres"]);
      }
      return { code: 0, stdout: "" };
    };
    await dev(config, ".", runner, {});
    expect(calls.map((args) => args[0])).toEqual(
      variant === "sqlite" ? ["bun"] : ["docker", "bun", "docker"],
    );
    if (variant === "postgres") expect(calls[2]).toContain("down");
  });
}

test("ls consulta labels via SSH, ordena e elimina duplicatas", async () => {
  const runner: Runner = async (args) => {
    expect(args.slice(0, 8)).toEqual([
      "ssh",
      "-T",
      "--",
      "host.tailnet",
      "docker",
      "ps",
      "--filter",
      "label=product",
    ]);
    return { code: 0, stdout: "exemplo\tweb\nexemplo\tapi\nexemplo\tapi\n" };
  };
  expect(await listProducts(".", runner, { DANGUS_HOST: "host.tailnet" })).toBe(
    "PRODUTO\tAPP\nexemplo\tapi\nexemplo\tweb",
  );
});

test("ls falha quando SSH falha ou Host é inválido", async () => {
  const runner: Runner = async () => ({ code: 1, stdout: "" });
  await expect(listProducts(".", runner, {})).rejects.toThrow(
    "Falha ao listar",
  );
  await expect(
    listProducts(".", runner, { DANGUS_HOST: "-oProxyCommand=x" }),
  ).rejects.toThrow("Host Tailscale inválido");
});

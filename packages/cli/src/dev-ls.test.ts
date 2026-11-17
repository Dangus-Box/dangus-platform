import { expect, test } from "bun:test";
import { loadConfig } from "./config";
import type { Runner } from "./deploy";
import { dev } from "./dev";
import { listProducts } from "./ls";

for (const variant of ["sqlite", "postgres"]) {
  test(`dev runs ${variant} with local environment and only its own database`, async () => {
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

test("ls queries labels over SSH, sorts and deduplicates", async () => {
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

test("ls fails when SSH fails or the Host is invalid", async () => {
  const runner: Runner = async () => ({ code: 1, stdout: "" });
  await expect(listProducts(".", runner, {})).rejects.toThrow("Failed to list");
  await expect(
    listProducts(".", runner, { DANGUS_HOST: "-oProxyCommand=x" }),
  ).rejects.toThrow("Invalid Tailscale Host");
});

type ComposeDoc = {
  services: { postgres: { volumes?: string[] } };
  volumes?: Record<string, unknown>;
};

async function composeOf(directory: string) {
  const config = await loadConfig("examples/postgres");
  let compose: { project: string; doc: ComposeDoc } | undefined;
  await dev(config, directory, async (args) => {
    if (args.includes("up"))
      compose = {
        project: args[args.indexOf("-p") + 1] as string,
        doc: Bun.YAML.parse(
          await Bun.file(args[args.indexOf("-f") + 1] as string).text(),
        ) as ComposeDoc,
      };
    return { code: 0, stdout: "" };
  });
  if (!compose) throw new Error("compose up did not run");
  return compose;
}

test("dev persists Postgres data in a named volume across runs", async () => {
  const { doc } = await composeOf("examples/postgres");
  expect(doc.services.postgres.volumes).toEqual([
    "data:/var/lib/postgresql/data",
  ]);
  expect(Object.keys(doc.volumes ?? {})).toEqual(["data"]);
});

test("dev isolates the Compose project by directory without stopping another worktree database", async () => {
  const a = await composeOf("/worktrees/a/examples/postgres");
  const b = await composeOf("/worktrees/b/examples/postgres");
  expect(a.project).toStartWith("dangus-dev-exemplo-postgres-");
  expect(a.project).not.toBe(b.project);
});

test("dev stops the App on signal and still stops Postgres", async () => {
  const config = await loadConfig("examples/postgres");
  const controller = new AbortController();
  const signals: Record<string, AbortSignal | undefined> = {};
  await expect(
    dev(
      config,
      ".",
      async (args, _env, _cwd, _stream, signal) => {
        const step = args[0] === "bun" ? "bun" : (args.at(-1) as string);
        signals[step] = signal;
        if (step === "bun") {
          controller.abort();
          return { code: 130, stdout: "" };
        }
        return { code: 0, stdout: "" };
      },
      {},
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(signals.bun).toBe(controller.signal);
  expect(signals["--wait"]).toBe(controller.signal);
  expect(Object.keys(signals)).toContain("down");
  expect(signals.down).toBeUndefined();
});

test("ls shows only Product Apps, excluding the Platform proxy and database", async () => {
  const runner: Runner = async () => ({
    code: 0,
    stdout:
      "platform\tproxy\nexemplo\tpostgres\nmeu produto\tapi\nexemplo\tweb\n",
  });
  expect(await listProducts(".", runner, {})).toBe(
    "PRODUTO\tAPP\nexemplo\tweb\nmeu produto\tapi",
  );
});

test("ls with no Apps on the Host shows only the header", async () => {
  const runner: Runner = async () => ({ code: 0, stdout: "" });
  expect(await listProducts(".", runner, {})).toBe("PRODUTO\tAPP");
});

test("ls includes SSH stderr on failure, strips control sequences and limits length", async () => {
  const runner: Runner = async () => ({
    code: 255,
    stdout: "",
    stderr: `ssh: Could not resolve hostname dangus-host\x1b[31m\r\n${"x".repeat(2000)}`,
  });
  const error = await listProducts(".", runner, {}).catch((e: Error) => e);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toStartWith(
    "Failed to list Apps on the Host: ssh: Could not resolve hostname dangus-host",
  );
  expect(message).not.toContain("\x1b");
  expect(message).not.toContain("\r");
  expect(message.length).toBeLessThan(600);
});

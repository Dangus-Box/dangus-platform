import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const path = `${import.meta.dir}/`;
const config = Bun.YAML.parse(readFileSync(`${path}deploy.yml`, "utf8")) as {
  registry: unknown;
  accessories: Record<
    string,
    { port?: string; cmd: string; image: string; volumes: string[] }
  >;
};
const dashboard = JSON.parse(
  readFileSync(`${path}dashboards/stack-ops.json`, "utf8"),
);

test("Stack Ops mantém serviços internos, limites e retenção", () => {
  const { grafana, loki, prometheus } = config.accessories;
  expect(grafana.port).toBe("127.0.0.1:3300:3000");
  expect(loki.port).toBeUndefined();
  expect(prometheus.port).toBeUndefined();
  expect(prometheus.cmd).toContain("--web.enable-remote-write-receiver");
  expect(prometheus.cmd).toContain("--storage.tsdb.retention.time=30d");
  expect(readFileSync(`${path}loki.yml`, "utf8")).toContain(
    "retention_period: 336h",
  );
  expect(grafana.volumes).toContain("dangus-ops-grafana:/var/lib/grafana");
  for (const item of [grafana, loki, prometheus]) {
    expect(item.image).toMatch(/:[^@]+@sha256:[a-f0-9]{64}$/);
  }
});

test("dashboard consulta sinais por Produto", () => {
  expect(dashboard.templating.list[0].name).toBe("product");
  expect(dashboard.panels).toHaveLength(6);
  for (const panel of dashboard.panels)
    expect(panel.targets[0].expr).toContain("$product");
});

async function deploy(secrets: { key: string; value: string }[]) {
  const bin = mkdtempSync(`${tmpdir()}/ops-deploy-`);
  const fake = (name: string, body: string) => {
    writeFileSync(`${bin}/${name}`, `#!/bin/sh\n${body}\n`);
    chmodSync(`${bin}/${name}`, 0o755);
  };
  fake("bws", `echo '${JSON.stringify(secrets)}'`);
  fake("docker", `printf '%s\\n' "$@" > ${bin}/args; env > ${bin}/env`);
  const child = Bun.spawn([`${path}deploy.sh`], {
    env: { PATH: `${bin}:${process.env.PATH}`, SSH_AUTH_SOCK: "/ssh-agent" },
    stderr: "pipe",
  });
  const code = await child.exited;
  const read = (file: string) => {
    try {
      return readFileSync(`${bin}/${file}`, "utf8");
    } catch {
      return "";
    }
  };
  return { code, args: read("args"), env: read("env") };
}

test("deploy da Stack Ops recusa senha do Grafana vazia", async () => {
  const run = await deploy([{ key: "ops__GRAFANA_ADMIN_PASSWORD", value: "" }]);
  expect(run.code).not.toBe(0);
  expect(run.args).toBe("");
});

test("deploy da Stack Ops passa a senha só por ambiente, sem Docker socket", async () => {
  const run = await deploy([
    { key: "ops__GRAFANA_ADMIN_PASSWORD", value: "s3nt1nel" },
  ]);
  expect(run.code).toBe(0);
  expect(run.args).not.toContain("s3nt1nel");
  expect(run.args).not.toContain("docker.sock");
  expect(run.args).toContain("accessory\nboot\nall");
  expect(run.env).toContain("GF_SECURITY_ADMIN_PASSWORD=s3nt1nel");
});

test("Stack Ops não faz login em registry", () => {
  expect(config.registry).toEqual({ server: "localhost:5555" });
});

test('"All" do filtro de Produto é aceito pelo Loki', () => {
  // O Loki recusa seletores que casam com valor vazio, como product=~".*".
  const { allValue } = dashboard.templating.list[0];
  expect(new RegExp(`^(?:${allValue})$`).test("")).toBe(false);
});

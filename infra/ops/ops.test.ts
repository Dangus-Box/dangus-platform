import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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

async function deploy(
  secrets: { key: string; value: string }[],
  { failExec = false, route = false } = {},
) {
  const bin = mkdtempSync(`${tmpdir()}/ops-deploy-`);
  const fake = (name: string, body: string) => {
    writeFileSync(`${bin}/${name}`, `#!/bin/sh\n${body}\n`);
    chmodSync(`${bin}/${name}`, 0o755);
  };
  fake("bws", `echo '${JSON.stringify(secrets)}'`);
  if (route) writeFileSync(`${bin}/route`, "");
  // Imita o Kamal: stop/reboot de accessory com proxy executa
  // `kamal-proxy remove`, que falha se a rota não existe.
  const pub = "umami --config-file deploy.yml ";
  fake(
    "docker",
    `printf '%s\\n' "$@" >> ${bin}/args; env > ${bin}/env
case " $* " in
  *" accessory exec umami "*) ${failExec ? "exit 1" : ":"} ;;
  *" accessory stop ${pub}"*|*" accessory reboot ${pub}"*)
    [ -f ${bin}/route ] || { echo 'Error: service not found' >&2; exit 1; }
    rm ${bin}/route ;;
esac
case " $* " in *" accessory boot ${pub}"*|*" accessory reboot ${pub}"*) touch ${bin}/route ;; esac`,
  );
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
  return {
    code,
    args: read("args"),
    env: read("env"),
    routed: existsSync(`${bin}/route`),
  };
}

test("deploy da Stack Ops recusa senha do Grafana vazia", async () => {
  const run = await deploy([{ key: "ops__GRAFANA_ADMIN_PASSWORD", value: "" }]);
  expect(run.code).not.toBe(0);
  expect(run.args).toBe("");
});

test("deploy da Stack Ops passa a senha só por ambiente, sem Docker socket", async () => {
  const run = await deploy([
    { key: "ops__GRAFANA_ADMIN_PASSWORD", value: "s3nt1nel" },
    { key: "ops__UMAMI_APP_SECRET", value: "secret" },
    { key: "ops__UMAMI_DB_PASSWORD", value: "dbpass" },
    { key: "ops__UMAMI_ADMIN_PASSWORD", value: "adminpass" },
  ]);
  expect(run.code).toBe(0);
  expect(run.args).not.toContain("s3nt1nel");
  expect(run.args).not.toContain("docker.sock");
  expect(run.args).toContain("accessory\nexec\numami");
  expect(run.args).toContain("accessory\nreboot\numami");
  expect(run.env).toContain("UMAMI_ADMIN_PASSWORD=adminpass");
  expect(run.args).not.toContain("adminpass");
  expect(run.env).toContain("GF_SECURITY_ADMIN_PASSWORD=s3nt1nel");
});

test("falha ao configurar senha impede publicação", async () => {
  const run = await deploy(
    [
      { key: "ops__GRAFANA_ADMIN_PASSWORD", value: "x" },
      { key: "ops__UMAMI_APP_SECRET", value: "x" },
      { key: "ops__UMAMI_DB_PASSWORD", value: "x" },
      { key: "ops__UMAMI_ADMIN_PASSWORD", value: "adminpass" },
    ],
    { failExec: true, route: true },
  );
  expect(run.code).not.toBe(0);
  expect(run.routed).toBe(false);
  expect(run.args).toContain("accessory\nexec\numami");
  expect(run.args).not.toContain(
    "accessory\nboot\numami\n--config-file\ndeploy.yml",
  );
  // O container privado com admin/umami não fica rodando na rede do Host.
  expect(run.args).toMatch(
    /accessory\nstop\numami\n--config-file\n\/work\/\.deploy-private\.\w+\n--version=\w+\n$/,
  );
});

for (const route of [false, true])
  test(`deploy publica o Umami ${route ? "no redeploy" : "no primeiro deploy"}`, async () => {
    const run = await deploy(
      [
        { key: "ops__GRAFANA_ADMIN_PASSWORD", value: "x" },
        { key: "ops__UMAMI_APP_SECRET", value: "x" },
        { key: "ops__UMAMI_DB_PASSWORD", value: "x" },
        { key: "ops__UMAMI_ADMIN_PASSWORD", value: "adminpass" },
      ],
      { route },
    );
    expect(run.code).toBe(0);
    expect(run.routed).toBe(true);
  });

test("Umami e banco têm limites, imagens fixas e caminhos neutros", () => {
  const { umami, "umami-db": db } = config.accessories;
  expect(umami.port).toBeUndefined();
  expect(db.port).toBeUndefined();
  expect(db.volumes).toContain("dangus-ops-umami-db:/var/lib/postgresql/data");
  for (const item of [umami, db])
    expect(item.image).toMatch(/:[^@]+@sha256:[a-f0-9]{64}$/);
  const yaml = readFileSync(`${path}deploy.yml`, "utf8");
  expect(yaml).toContain("TRACKER_SCRIPT_NAME: t.js");
  expect(yaml).toContain("COLLECT_API_ENDPOINT: /api/e");
  expect(yaml).toContain("path: /api/heartbeat");
});

test("deploy recusa secret ausente antes de chamar Docker", async () => {
  const run = await deploy([
    { key: "ops__GRAFANA_ADMIN_PASSWORD", value: "ok" },
  ]);
  expect(run.code).not.toBe(0);
  expect(run.args).toBe("");
});

test("Stack Ops não faz login em registry", () => {
  expect(config.registry).toEqual({ server: "localhost:5555" });
});

test('"All" do filtro de Produto é aceito pelo Loki', () => {
  // O Loki recusa seletores que casam com valor vazio, como product=~".*".
  const { allValue } = dashboard.templating.list[0];
  expect(new RegExp(`^(?:${allValue})$`).test("")).toBe(false);
});

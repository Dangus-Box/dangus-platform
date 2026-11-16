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
  deploy_timeout?: number;
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
  {
    failExec = false,
    route = false,
    edgeContainer = route,
    edgeRoute = route,
    failUnleashHealth = false,
    missingUnleash = "",
    chatId = "1234",
  } = {},
) {
  if (secrets.some((s) => s.key === "ops__UMAMI_ADMIN_PASSWORD"))
    secrets.push(
      { key: "ops__UNLEASH_DB_PASSWORD", value: "dbpass" },
      { key: "ops__UNLEASH_ADMIN_PASSWORD", value: "adminpass" },
      {
        key: "ops__UNLEASH_FRONTEND_TOKEN",
        value: "default:production.frontend",
      },
      {
        key: "ops__UNLEASH_BACKEND_TOKEN",
        value: "default:production.backend",
      },
    );
  secrets.push(
    { key: "ops__R2_BACKUP_ACCESS_KEY_ID", value: "access" },
    { key: "ops__R2_BACKUP_SECRET_ACCESS_KEY", value: "secret" },
    { key: "ops__HEALTHCHECKS_BACKUP_URL", value: "https://example.com/check" },
    { key: "platform__R2_ENDPOINT", value: "https://example.com" },
    { key: "platform__TELEGRAM_BOT_TOKEN", value: "test-token" },
    { key: "platform__TELEGRAM_CHAT_ID", value: chatId },
  );
  const missing = secrets.find((s) => s.key === missingUnleash);
  if (missing) missing.value = "";
  const bin = mkdtempSync(`${tmpdir()}/ops-deploy-`);
  const fake = (name: string, body: string) => {
    writeFileSync(`${bin}/${name}`, `#!/bin/sh\n${body}\n`);
    chmodSync(`${bin}/${name}`, 0o755);
  };
  fake("bws", `echo '${JSON.stringify(secrets)}'`);
  if (route) writeFileSync(`${bin}/route`, "");
  if (edgeContainer) writeFileSync(`${bin}/edge-container`, "");
  if (edgeRoute) writeFileSync(`${bin}/edge-route`, "");
  // Imita o Kamal: stop/reboot de accessory com proxy executa
  // `kamal-proxy remove`, que falha se a rota não existe.
  const pub = "umami --config-file deploy.yml ";
  fake(
    "docker",
    `printf '%s\\n' "$@" >> ${bin}/args; env > ${bin}/env
cp .alerts-generated.yml ${bin}/alerts 2>/dev/null
case " $* " in
  *" accessory exec umami "*) ${failExec ? "exit 1" : ":"} ;;
  *" accessory stop ${pub}"*|*" accessory reboot ${pub}"*)
    [ -f ${bin}/route ] || { echo 'Error: service not found' >&2; exit 1; }
    rm ${bin}/route ;;
esac
case " $* " in *" accessory boot ${pub}"*|*" accessory reboot ${pub}"*) touch ${bin}/route ;; esac
# Imita o Kamal: boot pula accessory cujo container já existe.
case " $* " in
  *" accessory exec unleash "*) ${failUnleashHealth ? "exit 1" : ":"} ;;
  *" accessory stop unleash-edge --config-file deploy.yml "*)
    [ -f ${bin}/edge-route ] || { echo 'Error: service not found' >&2; exit 1; }
    rm ${bin}/edge-route ;;
  *" accessory remove_container unleash-edge "*) rm -f ${bin}/edge-container ;;
  *" accessory boot unleash-edge "*)
    [ -f ${bin}/edge-container ] && exit 0
    touch ${bin}/edge-container
    case " $* " in *" deploy.yml "*) touch ${bin}/edge-route ;; esac ;;
esac`,
  );
  const child = Bun.spawn([`${path}deploy.sh`], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      SSH_AUTH_SOCK: "/ssh-agent",
      DANGUS_BACKUP_AGE_PUBLIC_KEY_FILE: `${path}../../packages/cli/test/fixtures/age.pub`,
    },
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
    alerts: read("alerts"),
    routed: existsSync(`${bin}/route`),
    edgeRouted: existsSync(`${bin}/edge-route`),
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
  expect(run.args).toContain(
    "accessory\nboot\numami\n--config-file\ndeploy.yml",
  );
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

test("kamal-proxy espera o boot do Umami com 0,2 vCPU", () => {
  // Medido: ~33 s até /api/heartbeat responder; o padrão do Kamal é 30 s.
  expect(config.deploy_timeout).toBeGreaterThanOrEqual(120);
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

test("Unleash mantém admin privado e Edge público", () => {
  const {
    unleash,
    "unleash-db": db,
    "unleash-edge": edge,
  } = config.accessories;
  expect(unleash.port).toBe("127.0.0.1:4242:4242");
  expect(db.port).toBeUndefined();
  expect(db.volumes).toContain(
    "dangus-ops-unleash-db:/var/lib/postgresql/data",
  );
  for (const item of [unleash, db, edge])
    expect(item.image).toMatch(/:[^@]+@sha256:[a-f0-9]{64}$/);
  const yaml = readFileSync(`${path}deploy.yml`, "utf8");
  expect(yaml).toContain("host: flags.dangus-box.com");
  expect(yaml).toContain("UNLEASH_DEFAULT_ADMIN_USERNAME: admin");
});

for (const name of [
  "DB_PASSWORD",
  "ADMIN_PASSWORD",
  "FRONTEND_TOKEN",
  "BACKEND_TOKEN",
])
  test(`deploy recusa secret vazio do Unleash: ${name}`, async () => {
    const run = await deploy(
      [
        { key: "ops__GRAFANA_ADMIN_PASSWORD", value: "x" },
        { key: "ops__UMAMI_APP_SECRET", value: "x" },
        { key: "ops__UMAMI_DB_PASSWORD", value: "x" },
        { key: "ops__UMAMI_ADMIN_PASSWORD", value: "adminpass" },
      ],
      { missingUnleash: `ops__UNLEASH_${name}` },
    );
    expect(run.code).not.toBe(0);
    expect(run.args).toBe("");
  });

const unleashSecrets = () => [
  { key: "ops__GRAFANA_ADMIN_PASSWORD", value: "x" },
  { key: "ops__UMAMI_APP_SECRET", value: "x" },
  { key: "ops__UMAMI_DB_PASSWORD", value: "x" },
  { key: "ops__UMAMI_ADMIN_PASSWORD", value: "adminpass" },
];

// O Edge encerra se não valida TOKENS no upstream ao iniciar.
test("deploy só sobe o Edge depois do Unleash server responder", async () => {
  const run = await deploy(unleashSecrets());
  expect(run.code).toBe(0);
  for (const secret of ["dbpass", "adminpass", "production."])
    expect(run.args).not.toContain(secret);
  expect(run.env).toContain("TOKENS=default:production.backend");
  const health = run.args.indexOf("accessory\nexec\nunleash\n");
  expect(health).toBeGreaterThan(
    run.args.indexOf("accessory\nboot\nunleash\n"),
  );
  expect(health).toBeLessThan(
    run.args.indexOf("accessory\nboot\nunleash-edge\n"),
  );
});

test("Unleash server sem resposta impede o boot do Edge", async () => {
  const run = await deploy(unleashSecrets(), { failUnleashHealth: true });
  expect(run.code).not.toBe(0);
  expect(run.args).not.toContain("accessory\nboot\nunleash-edge\n");
});

for (const [name, state] of [
  ["no primeiro deploy", { edgeContainer: false, edgeRoute: false }],
  ["no redeploy", { edgeContainer: true, edgeRoute: true }],
  ["após primeiro deploy sem rota", { edgeContainer: true, edgeRoute: false }],
] as const)
  test(`deploy publica o Edge ${name}`, async () => {
    const run = await deploy(unleashSecrets(), state);
    expect(run.code).toBe(0);
    expect(run.edgeRouted).toBe(true);
  });

test("deploy provisiona o Telegram sem gravar o token", async () => {
  const run = await deploy(unleashSecrets());
  expect(run.code).toBe(0);
  expect(run.env).toContain("TELEGRAM_BOT_TOKEN=test-token");
  expect(run.args).not.toContain("test-token");
  expect(run.alerts).not.toContain("test-token");
  expect(run.alerts).toContain("bottoken: $TELEGRAM_BOT_TOKEN");
  expect(run.alerts).toContain('chatid: "1234"');
  expect(existsSync(`${path}.alerts-generated.yml`)).toBe(false);
});

test("deploy recusa chat ID do Telegram inválido antes de chamar Docker", async () => {
  const run = await deploy(unleashSecrets(), { chatId: '1"\nbottoken: x' });
  expect(run.code).not.toBe(0);
  expect(run.args).toBe("");
});

// O boot do Kamal pula container existente: sem recriar, o Grafana já no Host
// não recebe o arquivo de alertas nem o TELEGRAM_BOT_TOKEN.
test("redeploy recria o Grafana para aplicar os alertas", async () => {
  const run = await deploy(unleashSecrets());
  expect(run.code).toBe(0);
  const remove = run.args.indexOf("accessory\nremove_container\ngrafana\n");
  expect(remove).toBeGreaterThanOrEqual(0);
  expect(run.args.indexOf("accessory\nboot\ngrafana\n")).toBeGreaterThan(
    remove,
  );
});

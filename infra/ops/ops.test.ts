import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const path = `${import.meta.dir}/`;
const config = Bun.YAML.parse(readFileSync(`${path}deploy.yml`, "utf8")) as {
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

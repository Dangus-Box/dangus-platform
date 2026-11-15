import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { observability } from "./index";

describe("observabilidade", () => {
  test("oculta campos padrão e extras em objetos e headers", () => {
    let output = "";
    const { logger } = observability({
      redact: ["segredo"],
      destination: {
        write: (chunk) => {
          output += chunk;
        },
      },
    });
    logger.info({
      password: "secret1",
      token: "secret2",
      authorization: "secret3",
      cookie: "secret4",
      cpf: "secret5",
      email: "secret6",
      phone: "secret7",
      headers: {
        Authorization: "secret8",
        "proxy-authorization": "secret9",
        "x-api-key": "secret10",
        "x-auth-token": "secret11",
        "set-cookie": "secret12",
      },
      nested: [{ segredo: "secret13" }],
      visible: "ok",
    });
    const logged = JSON.parse(output);
    for (const field of [
      "password",
      "token",
      "authorization",
      "cookie",
      "cpf",
      "email",
      "phone",
    ])
      expect(logged[field]).toBe("[Redacted]");
    for (const value of Object.values(logged.headers))
      expect(value).toBe("[Redacted]");
    expect(logged.nested[0].segredo).toBe("[Redacted]");
    expect(logged.visible).toBe("ok");
    expect(output).not.toContain("secret");
  });

  test("oculta campos em bindings de child loggers", () => {
    let output = "";
    const { logger } = observability({
      destination: { write: (chunk) => (output += chunk) },
    });
    logger.child({ token: "secret", headers: { cookie: "secret" } }).info("x");
    expect(output).not.toContain("secret");
  });

  test("preserva erros e datas, ocultando campos sensíveis do erro", () => {
    let output = "";
    const { logger } = observability({
      destination: { write: (chunk) => (output += chunk) },
    });
    const error = Object.assign(new Error("boom"), {
      config: { headers: { Authorization: "Bearer secret" } },
    });
    logger.error({ err: error, when: new Date(0) });
    const logged = JSON.parse(output);
    expect(logged.err.message).toBe("boom");
    expect(logged.err.stack).toContain("Error: boom");
    expect(logged.err.config.headers.Authorization).toBe("[Redacted]");
    expect(logged.when).toBe("1970-01-01T00:00:00.000Z");
    expect(output).not.toContain("secret");
  });

  test("rotas inexistentes não criam séries por path", async () => {
    const obs = observability();
    const app = new Elysia().use(obs.plugin);
    for (const id of ["1", "2", "3"])
      await app.handle(new Request(`http://localhost/users/${id}?token=x`));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const metrics = await (
      await app.handle(new Request("http://localhost/metrics"))
    ).text();
    expect(metrics).not.toContain("/users/");
    expect(metrics).not.toContain("token");
    expect(metrics).toContain(
      'http_server_requests_total{route="unknown",method="GET",status_code="404"} 3',
    );
  });

  test("health, readiness e métricas por rota", async () => {
    const obs = observability();
    const app = new Elysia()
      .use(obs.plugin)
      .get("/items/:id", () => "ok")
      .get("/failure", ({ set }) => {
        set.status = 500;
        return "error";
      });
    const get = (path: string) =>
      app.handle(new Request(`http://localhost${path}`));
    expect((await get("/health")).status).toBe(200);
    expect((await get("/ready")).status).toBe(503);
    obs.markReady();
    expect((await get("/ready")).status).toBe(200);
    await get("/items/123");
    await get("/failure");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const metrics = await (await get("/metrics")).text();
    expect(metrics).toContain('route="/items/:id"');
    expect(metrics).toContain("http_server_requests");
    expect(metrics).toContain("http_server_duration_seconds");
    expect(metrics).toContain("http_server_errors");
  });
});

import {
  PrometheusExporter,
  PrometheusSerializer,
} from "@opentelemetry/exporter-prometheus";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { Elysia } from "elysia";
import pino, { type DestinationStream } from "pino";

const defaultRedact = [
  "password",
  "token",
  "authorization",
  "cookie",
  "cpf",
  "email",
  "phone",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
];

export function observability(
  options: {
    redact?: string[];
    development?: boolean;
    destination?: DestinationStream;
  } = {},
) {
  const sensitive = new Set(
    [...defaultRedact, ...(options.redact ?? [])].map((field) =>
      field.toLowerCase(),
    ),
  );
  const seen = new WeakSet<object>();
  function redact(value: unknown): unknown {
    if (!value || typeof value !== "object") return value;
    if (value instanceof Error) return redact(pino.stdSerializers.err(value));
    if ("toJSON" in value && typeof value.toJSON === "function")
      return redact(value.toJSON());
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result = Array.isArray(value)
      ? value.map(redact)
      : Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            sensitive.has(key.toLowerCase()) ? "[Redacted]" : redact(entry),
          ]),
        );
    seen.delete(value);
    return result;
  }
  const logger = pino(
    {
      formatters: {
        bindings: (object) => redact(object) as Record<string, unknown>,
        log: (object) => redact(object) as Record<string, unknown>,
      },
      ...(options.destination
        ? {}
        : (options.development ?? process.env.NODE_ENV === "development")
          ? { transport: { target: "pino-pretty" } }
          : {}),
    },
    options.destination,
  );
  // pino descarta formatters.bindings nos filhos; oculta os bindings de cada child.
  const child = logger.child;
  logger.child = function (this: typeof logger, bindings, childOptions) {
    return child.call(this, redact(bindings) as typeof bindings, childOptions);
  } as typeof child;
  const exporter = new PrometheusExporter({ preventServerStart: true });
  const provider = new MeterProvider({ readers: [exporter] });
  const meter = provider.getMeter("@dangus-box/server");
  const requests = meter.createCounter("http_server_requests", {
    description: "Requisições HTTP",
  });
  const errors = meter.createCounter("http_server_errors", {
    description: "Erros HTTP",
  });
  const duration = meter.createHistogram("http_server_duration_seconds", {
    description: "Duração das requisições HTTP",
    unit: "s",
  });
  const starts = new WeakMap<Request, number>();
  let ready = false;
  const plugin = new Elysia({ name: "dangus-observability" })
    .decorate("logger", logger)
    .onRequest(({ request }) => {
      starts.set(request, performance.now());
    })
    .onAfterResponse({ as: "global" }, ({ request, route, set, response }) => {
      const status =
        response instanceof Response
          ? response.status
          : typeof set.status === "number"
            ? set.status
            : 200;
      const attributes = {
        route: route || "unknown",
        method: request.method,
        status_code: status,
      };
      requests.add(1, attributes);
      if (status >= 500) errors.add(1, attributes);
      duration.record(
        (performance.now() - (starts.get(request) ?? performance.now())) / 1000,
        attributes,
      );
    })
    .get("/health", () => ({ status: "ok" }))
    .get("/ready", ({ set }) => {
      if (!ready) {
        set.status = 503;
        return { status: "not ready" };
      }
      return { status: "ok" };
    })
    .get("/metrics", async ({ set }) => {
      const result = await exporter.collect();
      set.headers["content-type"] = "text/plain; version=0.0.4; charset=utf-8";
      return new PrometheusSerializer().serialize(result.resourceMetrics);
    });
  return {
    plugin,
    logger,
    markReady: () => {
      ready = true;
    },
  };
}

export { migratePostgres, migrateSqlite } from "./migrate";

import { expect, test } from "bun:test";
import { validateConfig } from "./config";

const build = (api: object, extra: object = {}) => ({
  name: "p",
  apps: { api: { domain: "api.p.com", ...api } },
  database: "postgres",
  deployTimeoutSeconds: 120,
  ...extra,
});

test.each([
  ["path ..", { path: "../x" }],
  ["dockerfile inner ..", { dockerfile: "a/../b" }],
  ["absolute entry", { entry: "/etc/passwd" }],
  ["windows path", { path: "C:\\x" }],
  ["healthcheck without slash", { healthcheckPath: "health" }],
  ["healthcheck newline", { healthcheckPath: "/a\nb" }],
  ["healthcheck space", { healthcheckPath: "/a b" }],
  ["healthcheck authority", { healthcheckPath: "//evil.com" }],
  ["healthcheck fragment", { healthcheckPath: "/a#b" }],
  ["target injection", { target: "a;rm" }],
  ["target newline", { target: "a\nb" }],
  ["empty target", { target: "" }],
  ["unknown field", { foo: 1 }],
  ["non-string entry", { entry: 5 }],
])("rejects %s", (_name, app) => {
  expect(() => validateConfig(build(app))).toThrow();
});

test.each([
  ":(top)x",
  "a*",
  "-x",
  "../x",
  "/abs",
])("rejects unsafe migrations %s", (migrations) => {
  expect(() => validateConfig(build({}, { migrations }))).toThrow();
});

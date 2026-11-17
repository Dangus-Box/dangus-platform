import { configureFlags, needsUpdate, OpenFeature } from "./index";

const server = process.env.UNLEASH_URL;
const login = await fetch(`${server}/auth/simple/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: "admin",
    password: process.env.UNLEASH_ADMIN_PASSWORD,
  }),
});
const cookie = login.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("Login failed");
const headers = { "content-type": "application/json", cookie };
async function write(path: string, method: string, body?: unknown) {
  const response = await fetch(
    `${server}/api/admin/projects/default/features${path}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
}
await write("", "POST", { name: "min-version", type: "release" });
const strategyPath = "/min-version/environments/production/strategies";
const strategy = (value: string) => ({
  name: "flexibleRollout",
  parameters: {
    rollout: "100",
    stickiness: "default",
    groupId: "min-version",
  },
  variants: [
    {
      name: "minima",
      weight: 1000,
      weightType: "variable",
      stickiness: "default",
      payload: { type: "string", value },
    },
  ],
});
const created = await fetch(
  `${server}/api/admin/projects/default/features${strategyPath}`,
  { method: "POST", headers, body: JSON.stringify(strategy("1.0.0")) },
);
if (!created.ok)
  throw new Error(`Create strategy: ${created.status} ${await created.text()}`);
const { id } = await created.json();
await write("/min-version/environments/production/on", "POST");
process.env.EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN =
  process.env.UNLEASH_FRONTEND_TOKEN;
const edge = `${process.env.EDGE_URL}/api/frontend`;
async function waitFor(expected: boolean) {
  for (let i = 0; i < 45; i++) {
    await configureFlags("test-native", edge);
    if (needsUpdate("1.0.0") === expected) return;
    await Bun.sleep(1000);
  }
  throw new Error(`Minimum Version did not change to ${expected}`);
}
try {
  // Wait for the variant to reach Edge before testing the initial value.
  for (let i = 0; i < 45; i++) {
    const data = await fetch(edge, {
      headers: { authorization: process.env.UNLEASH_FRONTEND_TOKEN as string },
    }).then((r) => r.text());
    if (data.includes("1.0.0")) break;
    if (i === 44) throw new Error("Initial variant missing from Edge");
    await Bun.sleep(1000);
  }
  await waitFor(false);
  await write(`${strategyPath}/${id}`, "PUT", strategy("1.1.0"));
  await waitFor(true);
  console.log(
    "Changing Minimum Version in Unleash makes the helper report an update is required OK",
  );
} finally {
  await OpenFeature.close();
}

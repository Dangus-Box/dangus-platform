import { configurarFlags, OpenFeature, precisaAtualizar } from "./index";

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
if (!cookie) throw new Error("Login falhou");
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
await write("", "POST", { name: "versao-minima", type: "release" });
const strategyPath = "/versao-minima/environments/production/strategies";
const strategy = (value: string) => ({
  name: "flexibleRollout",
  parameters: {
    rollout: "100",
    stickiness: "default",
    groupId: "versao-minima",
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
  throw new Error(
    `Criar estratégia: ${created.status} ${await created.text()}`,
  );
const { id } = await created.json();
await write("/versao-minima/environments/production/on", "POST");
process.env.EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN =
  process.env.UNLEASH_FRONTEND_TOKEN;
const edge = `${process.env.EDGE_URL}/api/frontend`;
async function esperar(expected: boolean) {
  for (let i = 0; i < 45; i++) {
    await configurarFlags("teste-native", edge);
    if (precisaAtualizar("1.0.0") === expected) return;
    await Bun.sleep(1000);
  }
  throw new Error(`Versão Mínima não mudou para ${expected}`);
}
try {
  // Wait for the variant to reach Edge before testing the initial value.
  for (let i = 0; i < 45; i++) {
    const data = await fetch(edge, {
      headers: { authorization: process.env.UNLEASH_FRONTEND_TOKEN as string },
    }).then((r) => r.text());
    if (data.includes("1.0.0")) break;
    if (i === 44) throw new Error("Variante inicial ausente no Edge");
    await Bun.sleep(1000);
  }
  await esperar(false);
  await write(`${strategyPath}/${id}`, "PUT", strategy("1.1.0"));
  await esperar(true);
  console.log(
    "Mudança da Versão Mínima no Unleash faz helper responder precisa atualizar OK",
  );
} finally {
  await OpenFeature.close();
}

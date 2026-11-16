const url = process.env.UMAMI_URL;
const headers = { "content-type": "application/json" };
const login = await fetch(`${url}/api/auth/login`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    username: "admin",
    password: process.env.UMAMI_ADMIN_PASSWORD,
  }),
});
if (!login.ok) throw new Error("Login falhou");
const { token } = await login.json();
const auth = { ...headers, authorization: `Bearer ${token}` };
const site = await fetch(`${url}/api/websites`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ name: "Teste", domain: "example.com" }),
});
if (!site.ok) throw new Error(`Criar site: ${await site.text()}`);
const { id } = await site.json();
const event = await fetch(`${url}/api/e`, {
  method: "POST",
  headers: {
    ...headers,
    "user-agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
  },
  body: JSON.stringify({
    type: "event",
    payload: {
      website: id,
      hostname: "example.com",
      url: "/teste",
      name: "teste",
    },
  }),
});
if (!event.ok) throw new Error(`Enviar evento: ${await event.text()}`);
const end = Date.now() + 60000;
const result = await fetch(
  `${url}/api/websites/${id}/events?startAt=${end - 120000}&endAt=${end}`,
  { headers: auth },
);
const body = await result.text();
if (!result.ok || !body.includes("teste"))
  throw new Error(`Evento ausente: ${body}`);
console.log("Evento recebido e consultado pela API OK");

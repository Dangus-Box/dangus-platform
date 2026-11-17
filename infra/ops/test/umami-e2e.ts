import { trackEvent } from "../../../packages/server/src/index";

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
if (!login.ok) throw new Error("Login failed");
const { token } = await login.json();
const auth = { ...headers, authorization: `Bearer ${token}` };
const site = await fetch(`${url}/api/websites`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ name: "Test", domain: "example.com" }),
});
if (!site.ok) throw new Error(`Create site: ${await site.text()}`);
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
      url: "/test",
      name: "test",
    },
  }),
});
if (!event.ok) throw new Error(`Send event: ${await event.text()}`);
const end = Date.now() + 60000;
const result = await fetch(
  `${url}/api/websites/${id}/events?startAt=${end - 120000}&endAt=${end}`,
  { headers: auth },
);
const body = await result.text();
if (!result.ok || !body.includes("test"))
  throw new Error(`Event missing: ${body}`);
console.log("Event received and queried through the API OK");
process.env.UMAMI_WEBSITE_ID = id;
await trackEvent({
  name: "server-event",
  hostname: "example.com",
  url: "/",
});
const serverEvents = await fetch(
  `${url}/api/websites/${id}/events?startAt=${end - 120000}&endAt=${Date.now() + 60000}`,
  { headers: auth },
);
const serverBody = await serverEvents.text();
if (!serverEvents.ok || !serverBody.includes("server-event"))
  throw new Error(`Server event missing: ${serverBody}`);
console.log("Event sent by @dangus-box/server received OK");

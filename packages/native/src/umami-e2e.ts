import { Platform } from "../test/react-native";
import { trackEvent } from "./index";

const base = process.env.UMAMI_URL;
const login = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: "admin",
    password: process.env.UMAMI_ADMIN_PASSWORD,
  }),
});
const { token } = await login.json();
const auth = {
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
};
const site = await fetch(`${base}/api/websites`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ name: "Mobile App", domain: "app" }),
});
if (!site.ok) throw new Error(await site.text());
const { id } = await site.json();
process.env.EXPO_PUBLIC_UMAMI_WEBSITE_ID = id;
await trackEvent("exemplo-mobile", "/", base);
Platform.OS = "ios";
await trackEvent("exemplo-mobile-ios", "/", base);
const end = Date.now() + 60000;
const events = await fetch(
  `${base}/api/websites/${id}/events?startAt=${end - 120000}&endAt=${end}`,
  { headers: auth },
);
const body = await events.text();
if (!events.ok || !body.includes("exemplo-mobile-ios"))
  throw new Error(`Event missing: ${body}`);
const sessions = await fetch(
  `${base}/api/websites/${id}/sessions?startAt=${end - 120000}&endAt=${end}`,
  { headers: auth },
).then((r) => r.json());
const systems = sessions.data.map((s: { os: string }) => s.os).sort();
if (systems.join() !== "Android OS,iOS")
  throw new Error(`Unexpected systems: ${systems}`);
console.log("Mobile App helper event received by Umami OK");

(async () => {
  const url = process.env.UMAMI_URL || "http://127.0.0.1:3000";
  const password = process.env.UMAMI_ADMIN_PASSWORD;
  if (!password || password === "umami")
    throw new Error("Invalid admin password.");
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${url}/api/heartbeat`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error("Umami did not become ready.");
  async function login(pass) {
    const res = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: pass }),
    });
    return res.ok ? res.json() : null;
  }
  let current = await login(password);
  if (!current) {
    current = await login("umami");
    if (!current)
      throw new Error(
        "Admin login failed with both the BWS password and the initial password.",
      );
    const res = await fetch(`${url}/api/users/${current.user.id}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${current.token}`,
      },
      body: JSON.stringify({ username: "admin", password }),
    });
    if (!res.ok) throw new Error("Failed to change admin password.");
  }
  if (!(await login(password)) || (await login("umami")))
    throw new Error("Admin password was not verified.");
  console.log("Admin password verified.");
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

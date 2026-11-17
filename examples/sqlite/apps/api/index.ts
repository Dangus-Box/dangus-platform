import { migrateSqlite, observability } from "@dangus-box/server";
import { Elysia, t } from "elysia";
import { db, sqlite } from "./db";
import { messages } from "./schema";

const observation = observability();
migrateSqlite(sqlite, "./drizzle");

new Elysia()
  .use(observation.plugin)
  .get("/mensagens", async () => await db.select().from(messages))
  .post(
    "/mensagens",
    async ({ body }) => await db.insert(messages).values(body).returning(),
    {
      body: t.Object({ texto: t.String({ minLength: 1 }) }),
    },
  )
  .listen(Number(process.env.PORT ?? 3000));
observation.markReady();
console.log(`API at http://localhost:${process.env.PORT ?? 3000}`);

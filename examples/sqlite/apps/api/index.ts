import { observability } from "@dangus-box/server";
import { Elysia, t } from "elysia";
import { db } from "./db";
import { mensagens } from "./schema";

const observacao = observability();

new Elysia()
  .use(observacao.plugin)
  .get("/mensagens", async () => await db.select().from(mensagens))
  .post(
    "/mensagens",
    async ({ body }) => await db.insert(mensagens).values(body).returning(),
    {
      body: t.Object({ texto: t.String({ minLength: 1 }) }),
    },
  )
  .listen(Number(process.env.PORT ?? 3000));
observacao.markReady();
console.log(`API em http://localhost:${process.env.PORT ?? 3000}`);

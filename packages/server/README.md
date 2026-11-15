# @dangus-box/server

Plugin Elysia de observabilidade para a App de um Produto:

```ts
import { observability } from "@dangus-box/server";
import { Elysia } from "elysia";

const observacao = observability({ redact: ["campoPrivado"] });
const app = new Elysia().use(observacao.plugin);
// Depois de concluir o boot da App:
observacao.markReady();
app.listen(3000);
```

`observacao.logger` também está disponível como `logger` no contexto das rotas. Ele produz JSON com pino e oculta campos sensíveis, inclusive em objetos aninhados e headers; `redact` acrescenta nomes de campos. Em desenvolvimento, `NODE_ENV=development` formata a saída para o terminal. A App expõe `/health`, `/ready` (503 até `markReady()`) e `/metrics` em formato Prometheus. As métricas OpenTelemetry contam requisições e erros HTTP 5xx e registram duração em segundos por rota, método e status.

## Migrations no boot

Execute as migrations antes de iniciar a API e marcar a readiness. Para SQLite, passe a conexão `Database` do Bun; para Postgres, passe a URL do Banco do Produto:

```ts
import { migrateSqlite, observability } from "@dangus-box/server";

const observacao = observability();
migrateSqlite(sqlite, "./drizzle"); // Postgres: await migratePostgres(databaseUrl, "./drizzle")
observacao.markReady();
app.listen(3000);
```

No Postgres, um advisory lock de sessão serializa as migrations. No SQLite, `BEGIN IMMEDIATE` obtém o lock de escrita antes de consultar o histórico, e `busy_timeout` espera até 30 segundos pelo outro processo; ambos os containers devem compartilhar o mesmo arquivo e um volume com suporte a locks SQLite. Se a migration falhar, a exceção interrompe o boot e o processo termina com erro. As migrations precisam ser Aditivas para conviver com a versão anterior durante o deploy.

Para executar também o teste de concorrência com Postgres, inicie `examples/postgres/compose.yaml` e rode `POSTGRES_TEST_URL=postgres://produto:produto@localhost:55432/produto bun test packages/server/src/migrate.test.ts` na raiz. O usuário do banco precisa poder criar bancos temporários.

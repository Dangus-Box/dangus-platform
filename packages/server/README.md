# @dangus-box/server

Plugin Elysia de observabilidade para a App de um Produto:

```ts
import { observability } from "@dangus-box/server";
import { Elysia } from "elysia";

const observation = observability({ redact: ["campoPrivado"] });
const app = new Elysia().use(observation.plugin);
// Depois de concluir o boot da App:
observation.markReady();
app.listen(3000);
```

`observation.logger` também está disponível como `logger` no contexto das rotas. Ele produz JSON com pino e oculta campos sensíveis, inclusive em objetos aninhados e headers; `redact` acrescenta nomes de campos. Em desenvolvimento, `NODE_ENV=development` formata a saída para o terminal. A App expõe `/health`, `/ready` (503 até `markReady()`) e `/metrics` em formato Prometheus. As métricas OpenTelemetry contam requisições e erros HTTP 5xx e registram duração em segundos por rota, método e status.

## Migrations no boot

Execute as migrations antes de iniciar a API e marcar a readiness. Para SQLite, passe a conexão `Database` do Bun; para Postgres, passe a URL do Banco do Produto:

```ts
import { migrateSqlite, observability } from "@dangus-box/server";

const observation = observability();
migrateSqlite(sqlite, "./drizzle"); // Postgres: await migratePostgres(databaseUrl, "./drizzle")
observation.markReady();
app.listen(3000);
```

No Postgres, um advisory lock de sessão serializa as migrations. No SQLite, `BEGIN IMMEDIATE` obtém o lock de escrita antes de consultar o histórico, e `busy_timeout` espera até 30 segundos pelo outro processo; ambos os containers devem compartilhar o mesmo arquivo e um volume com suporte a locks SQLite. Se a migration falhar, a exceção interrompe o boot e o processo termina com erro. As migrations precisam ser Aditivas para conviver com a versão anterior durante o deploy.

Para executar também o teste de concorrência com Postgres, inicie `examples/postgres/compose.yaml` e rode `POSTGRES_TEST_URL=postgres://produto:produto@localhost:55432/produto bun test packages/server/src/migrate.test.ts` na raiz. O usuário do banco precisa poder criar bancos temporários.

## Flags e analytics

No boot da App, configure o provider e avalie Flags exclusivamente pela API do OpenFeature. A dependência `@openfeature/server-sdk` deve ser instalada também pelo Produto.

```ts
import { configureFlags, trackEvent } from "@dangus-box/server";
import { OpenFeature } from "@openfeature/server-sdk";

await configureFlags("nome-do-produto");
const flags = OpenFeature.getClient();
const ativa = await flags.getBooleanValue("minha-flag", false);
await trackEvent({ name: "pedido", hostname: "produto.com", url: "/pedidos" });
// No encerramento da App: await OpenFeature.close();
```

`UNLEASH_TOKEN` ativa o provider com um token backend. Passe a `configureFlags` o nome da Config do Produto como `appName`, igual ao usado nas constraints das Flags. `UNLEASH_URL` é opcional e usa `http://dangus-ops-unleash:4242/api` por padrão. Sem token, o OpenFeature retorna os valores padrão sem acessar a rede. Aguarde `configureFlags` antes de avaliar: ele espera a primeira sincronização por até 3 segundos e nunca falha. Com o Unleash fora do ar ou lento, as Flags retornam os valores padrão até a sincronização.

`UMAMI_WEBSITE_ID` ativa o envio de eventos; `UMAMI_URL` é opcional e usa `http://dangus-ops-umami:3000` por padrão. Sem ID, `trackEvent` não faz nada. Informe o hostname e caminho associados ao evento; `data` pode conter propriedades adicionais. O envio tem timeout de 3 segundos e falhas HTTP ou de rede só geram um aviso no log, sem rejeitar a Promise; por isso `trackEvent` pode ser chamado sem `await` para não atrasar a resposta.

Declare os valores necessários em `secrets` da App na Config do Produto e guarde-os no BWS como `<produto>__<CHAVE>`. URLs alternativas também podem ser declaradas como secrets quando necessárias.

## Drizzle 1.0 e continuidade

Instale `drizzle-orm@1.0.0-rc.4` e `drizzle-kit@1.0.0-rc.4` no Produto. O SDK usa `drizzle-orm` como peerDependency `^1.0.0-rc.4`. Antes de atualizar um Produto existente, execute `bunx drizzle-kit up`: o formato passa de SQL com `meta/_journal.json` para `<timestamp>_<nome>/{migration.sql,snapshot.json}`. Preserve o SQL e todas as migrations aplicadas.

A rc.4 reconhece o histórico escrito pelo Drizzle 0.44.7 e acrescenta `name` e `applied_at`, sem reaplicar o SQL. Os testes usam a versão 0.44.7 real em SQLite e Postgres, verificam o upgrade, a próxima migration e dois boots idempotentes. Em 17/11/2026, uma cópia consistente (via `VACUUM INTO`) do Banco do Produto `exemplo-sqlite` do Host também passou por dois boots: dados preservados e uma única entrada de histórico, inclusive com `id` nulo do SDK 1.0.0. O volume original não foi alterado e não precisa ser resetado.

No SQLite, a rc.4 oficial abre sua própria transação e não aceita um `BEGIN IMMEDIATE` externo. Por isso o SDK executa as migrations e o upgrade do histórico na mesma transação de escrita, identificando o histórico antigo por timestamp ou hash e migrations novas pelo nome. Uma migration aplicada ausente localmente faz o boot falhar e reverte a transação. No Postgres, o migrator oficial roda sob o advisory lock. Mantenha as migrations Aditivas (ADR-0007).

Ao atualizar uma dependência local `file:` dos exemplos, use `bun remove @dangus-box/server` e `bun add @dangus-box/server@file:../../packages/server`: somente `bun install` não atualiza essa cópia no lockfile.

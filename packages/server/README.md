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

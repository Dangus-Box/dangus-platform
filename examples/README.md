# Produtos de exemplo

Dois Produtos independentes, com Apps em `apps/api` (Elysia), `apps/web` (TanStack Start) e `apps/mobile` (Expo). Cada variante usa Drizzle e integra o plugin de observabilidade de `@dangus-box/server`. As variantes têm instalações próprias e não fazem parte do workspace raiz.

Escolha `sqlite` ou `postgres` e execute os comandos dentro da respectiva pasta. Para Postgres, inicie primeiro o banco local com `docker compose up -d`; a conexão padrão usa a porta 55432 e credenciais locais de exemplo. É possível usar outro banco com `DATABASE_URL`.

```sh
cd examples/sqlite # ou examples/postgres
bun install
bun dev
```

Em outro terminal, teste a escrita e a leitura:

```sh
curl -X POST http://localhost:3000/mensagens -H 'content-type: application/json' -d '{"texto":"Olá"}'
curl http://localhost:3000/mensagens
```

A API usa a porta 3000 por padrão; ajuste-a com `PORT=3001 bun dev`. Para iniciar a App web, execute `bun run dev:web` e acesse a URL exibida. Para a App mobile, execute `bun run dev:mobile` e siga as instruções do Expo. Execute `bun run test` para verificar a migration e a rota; o Postgres precisa estar em execução para o teste da variante Postgres. O SQLite cria `produto.sqlite` localmente. Para parar o Postgres, use `docker compose down` na pasta da variante.

Cada variante instala `@dangus-box/server` diretamente de `../../packages/server` por uma dependência `file:`, pois está fora do workspace raiz. Execute `bun install` na raiz antes da instalação da variante. A API expõe `/health`, `/ready` e `/metrics`; as migrations rodam no boot antes de a API aceitar requisições e de a readiness ser marcada.

A Config do Produto SQLite declara `UNLEASH_TOKEN` e `UMAMI_WEBSITE_ID` como secrets da API. Para deploy, cadastre `exemplo-sqlite__UNLEASH_TOKEN` (token backend) e `exemplo-sqlite__UMAMI_WEBSITE_ID` no BWS. Localmente, sem essas variáveis, Flags usam valores padrão e analytics não envia eventos.

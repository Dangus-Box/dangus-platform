# Do projeto estruturado à produção

Siga na raiz do repositório do Produto. Este guia pressupõe a Stack Ops e o Host já provisionados. As seções 2 e 3 rodam só na sua máquina; a partir da 4 você mexe em produção. O [Produto SQLite](../examples/sqlite/) mostra uma integração completa; build e publicação mobile nas lojas ficam fora da v1.

## 1. Pré-requisitos

- O Produto já deve ter `apps/api` com Elysia, `apps/web` com TanStack Start e/ou `apps/mobile` com Expo, além de `drizzle.config.ts` na raiz com dialect `postgresql` ou `sqlite` e migrations em `drizzle/`. A Plataforma não cria a estrutura nem altera o código das Apps ([ADR-0012](adr/0012-adocao-sem-scaffold.md)).
- O repositório do Produto fica na organização `Dangus-Box` do GitHub: as imagens são publicadas em `ghcr.io/dangus-box/<produto>-<app>` com o `GITHUB_TOKEN` do workflow.
- Instale `bun`, Docker, `jq`, `tailscale` e o CLI `bws`; para restore, também `age`, `gzip` e `curl`. Conecte-se à tailnet e confirme com `tailscale status`.
- Para as seções 4 em diante, exporte `BWS_ACCESS_TOKEN` de uma machine account `operator` com leitura no projeto `ops` e escrita em `prod`. Use uma máquina confiável: o BWS CLI recebe valores em argumentos durante o Registro.

## 2. Inicializar

Instale uma versão publicada exata do CLI e inicialize:

```sh
bun add --dev --exact @dangus-box/cli@<versão>
bun run dangus init
```

O comando mostra as Apps e o banco detectados e pede confirmação; `--yes` dispensa as perguntas e preserva arquivos existentes diferentes. Ele instala versões exatas dos SDKs, gera `dangus.config.ts`, Dockerfiles para API e web, `.dockerignore`, `.github/workflows/deploy.yml` e `.github/workflows/restore.yml`, adiciona `.dangus/` ao `.gitignore` e imprime as linhas de integração da seção 3.

Revise `dangus.config.ts`:

- `name`: letras minúsculas, números e hífens; é o prefixo dos secrets (`<produto>__*`) e das Flags.
- `domain` de cada App: troque os domínios gerados (`api.<produto>.com`) por domínios da zona Cloudflare da Plataforma com um único nível de subdomínio, como `api-<produto>.dangus-box.com`. O mobile também exige um domínio.
- Produto sem web: remova `UMAMI_WEBSITE_ID` dos `secrets` da API, pois o Registro só cria o site no Umami quando há web.

Detalhes dos campos no [README do CLI](../packages/cli/README.md#config-do-produto).

## 3. Integrar as Apps

Aplique as linhas impressas pelo `init`. Abaixo, `nome-do-produto` é o `name` de `dangus.config.ts`.

**API** (`apps/api/index.ts`): substitua a execução de migrations que a App já tinha por `migrateSqlite`/`migratePostgres`, rode-a antes de `.listen()`, use o plugin e marque readiness após o boot. A API escuta na porta 3000.

```ts
import { configureFlags, migrateSqlite, observability, trackEvent } from "@dangus-box/server";
import { OpenFeature } from "@openfeature/server-sdk";

const observacao = observability();
migrateSqlite(sqlite, "./drizzle"); // Postgres: await migratePostgres(databaseUrl, "./drizzle")
await configureFlags("nome-do-produto");
const flags = OpenFeature.getClient();

new Elysia()
  .use(observacao.plugin)
  .get("/pedidos", async () => {
    const ativa = await flags.getBooleanValue("nome-do-produto.minha-flag", false);
    trackEvent({ name: "pedido", hostname: "api-produto.dangus-box.com", url: "/pedidos" });
    // ...
  })
  .listen(Number(process.env.PORT ?? 3000));
observacao.markReady();
```

Em SQLite, `sqlite` é o `Database` de `bun:sqlite` da App, aberto em `process.env.SQLITE_PATH` (o deploy define esse caminho persistente). Em Postgres, use `process.env.DATABASE_URL` (o deploy fornece). Veja o [SDK de servidor](../packages/server/README.md).

**Web**: na rota raiz, carregue os valores no servidor e passe-os aos componentes; em `apps/web/server.ts`, encaminhe `/t.js` e `/api/e` antes das demais rotas. Implementação completa: [raiz React](../examples/sqlite/apps/web/src/routes/__root.tsx) e [servidor web](../examples/sqlite/apps/web/server.ts).

```tsx
import { Analytics, Flags } from "@dangus-box/web";
import { createServerFn } from "@tanstack/react-start";

const config = createServerFn({ method: "GET" }).handler(() => ({
  websiteId: process.env.UMAMI_WEBSITE_ID,
  token: process.env.FLAGS_FRONTEND_TOKEN,
}));
export const Route = createRootRoute({ loader: () => config(), component: Root });
// Em Root: const { websiteId, token } = Route.useLoaderData();
// <head>: <Analytics websiteId={websiteId} />
// <body>: <Flags token={token} appName="nome-do-produto"><Outlet /></Flags>
```

```ts
import { proxyAnalytics } from "@dangus-box/web/server";

const proxy = await proxyAnalytics(request, { websiteId: process.env.UMAMI_WEBSITE_ID });
if (proxy) return proxy;
```

**Mobile**: configure as Flags no boot e envolva a árvore no provider ([exemplo](../examples/sqlite/apps/mobile/App.js)). As variáveis `EXPO_PUBLIC_*` são públicas, entram no build Expo e devem ser lidas no código da App:

```tsx
import { configurarFlags, enviarEvento, OpenFeature, OpenFeatureProvider } from "@dangus-box/native";

useEffect(() => {
  configurarFlags("nome-do-produto", undefined, process.env.EXPO_PUBLIC_FLAGS_FRONTEND_TOKEN);
}, []);
// <OpenFeatureProvider client={OpenFeature.getClient()}>{/* App */}</OpenFeatureProvider>
// enviarEvento("evento", undefined, undefined, process.env.EXPO_PUBLIC_UMAMI_WEBSITE_ID);
```

Flags e Remote Config: READMEs de [servidor](../packages/server/README.md#flags-e-analytics), [web](../packages/web/README.md) e [mobile](../packages/native/README.md).

Verifique:

```sh
bun run dangus doctor   # ou: bun run dangus doctor --base <ref>, se origin/main não existir
bun run dangus dev      # roda o script "dev" do package.json; em Postgres, sobe o banco local
```

O doctor confere a Config, a integração da API, a versão fixada do CLI em `bun.lock`, o Tailscale e se as migrations novas (ausentes em `origin/main`) são aditivas; não confere web, mobile, analytics nem Flags. Corrija as falhas antes de seguir. Sem secrets locais, Flags retornam os valores padrão e analytics não envia nada.

## 4. Registrar na Stack Ops

Confira no projeto `ops` do BWS os secrets listados no [README do CLI](../packages/cli/README.md#config-do-produto) e a integração Telegram no Healthchecks.io. Para Postgres, crie antes `<produto>__POSTGRES_PASSWORD` no projeto `prod`. Então:

```sh
bun run dangus register
```

O Registro cria ou reconhece o site no Umami (só com web), os tokens backend e frontend no Unleash, os checks de Backup e restore no Healthchecks.io, os registros DNS A e AAAA (DNS-only) de cada App apontando para o Host e as URLs de uptime da API e da web, e grava as credenciais em `prod`. Pode ser repetido; divergências ou duplicatas interrompem o comando para revisão.

## 5. Primeiro deploy

No GitHub do Produto, crie o secret `BWS_ACCESS_TOKEN` de uma machine account com leitura em `ops` e `prod`. A variável `DANGUS_HOST` é opcional (padrão `devbox-1`). O workflow lê do BWS `platform__TAILSCALE_OAUTH_CLIENT_ID`, `platform__TAILSCALE_OAUTH_CLIENT_SECRET`, `platform__DEPLOY_SSH_PRIVATE_KEY` e `platform__DEPLOY_SSH_KNOWN_HOSTS`, já configurados pela Plataforma ([workflow de deploy](../packages/cli/README.md#workflow-de-deploy)).

Faça commit dos arquivos gerados, das integrações, de `package.json` e `bun.lock`, e envie à `main`. Acompanhe **Actions → Deploy**: o push constrói e publica as imagens e faz o deploy. Confirme por HTTPS: a API em `https://<domínio-da-api>/ready` e a web em `/`.

## 6. Rollback

**Padrão** ([ADR-0013](adr/0013-rollback-por-redeploy.md)): em **Actions → Deploy → Run workflow**, informe em `sha` o SHA completo de um commit anterior da `main`. O workflow faz checkout desse commit e usa sua Config, seu CLI e as imagens já publicadas, sem novo build. Migrations não são desfeitas; por isso precisam ser aditivas. O próximo push na `main` faz deploy de novo; reverta o commit problemático antes.

**Emergência** (quando o workflow não pode rodar): `kamal rollback` volta ao container anterior ainda presente no Host, mas usa a configuração gerada pelo CLI atual, não a do commit antigo. Execute na raiz do Produto, no commit em produção, conectado à tailnet e com `BWS_ACCESS_TOKEN` que leia `ops` e `prod`:

```sh
set -euo pipefail
produto=nome-do-produto
versao=<SHA completo do deploy anterior>
dir=.dangus/rollback
install -d -m 700 "$dir/.kamal"
bun run dangus render | awk -v d="$dir" '/^service: /{n=split($2,p,"-"); f=d "/" p[n] ".yml"} {print > f}'
segredos="$(bws secret list)"
filtro='.[] | select(.key | startswith($p))'
eval "$(jq -r --arg p "${produto}__" "$filtro"' | "export \(.key | ltrimstr($p))=\(.value | @sh)"' <<<"$segredos")"
nomes="$(jq -r --arg p "${produto}__" "$filtro"' | .key | ltrimstr($p)' <<<"$segredos") KAMAL_REGISTRY_PASSWORD"
if [ -n "${POSTGRES_PASSWORD:-}" ]; then
  export DATABASE_URL="postgres://produto:$(jq -rn --arg s "$POSTGRES_PASSWORD" '$s | @uri')@${produto}-api-db:5432/produto"
  nomes="$nomes DATABASE_URL"
fi
export KAMAL_REGISTRY_USERNAME=nao-usado KAMAL_REGISTRY_PASSWORD=nao-usado
for n in $nomes; do echo "$n=\$$n"; done > "$dir/.kamal/secrets"
jq -r '.[] | select(.key == "platform__DEPLOY_SSH_KNOWN_HOSTS") | .value' <<<"$segredos" > "$dir/known_hosts"
eval "$(ssh-agent -s)"
jq -r '.[] | select(.key == "platform__DEPLOY_SSH_PRIVATE_KEY") | .value' <<<"$segredos" | ssh-add -
for app in api web; do
  [ -f "$dir/$app.yml" ] || continue
  docker run --rm --network host -v "$PWD/$dir:/dangus:ro" \
    -v "$PWD/$dir/known_hosts:/root/.ssh/known_hosts:ro" \
    -v "$SSH_AUTH_SOCK:/ssh-agent" -e SSH_AUTH_SOCK=/ssh-agent \
    -e KAMAL_REGISTRY_USERNAME $(printf -- '-e %s ' $nomes) \
    ghcr.io/basecamp/kamal:v2.12.0@sha256:7a3893b47dd328955f86fbf9ba887d08d612b74f96867f077750a53312537625 \
    rollback "$versao" --config-file "/dangus/$app.yml"
done
ssh-agent -k; rm -rf "$dir"
```

Os valores dos secrets ficam só no ambiente do shell, como no `dangus deploy`. Se o Kamal disser que a versão não está disponível, troque `rollback "$versao"` por `app containers` para listar as versões presentes no Host. Depois, reverta o commit na `main` ou faça o rollback padrão, para o próximo deploy não reintroduzir o problema.

## 7. Backup e restore

O Backup diário roda às 03:00 UTC no Host. Para validar já na Adoção, gere um Backup agora e restaure-o num destino descartável:

```sh
eval "$(ssh-agent -s)"
bws secret list | jq -r '.[] | select(.key == "platform__DEPLOY_SSH_PRIVATE_KEY") | .value' | ssh-add -
KAMAL_REGISTRY_USERNAME=nao-usado bun run dangus db backup
bun run dangus db restore
ssh-agent -k
```

O `db backup` usa o SSH agent para executar o Backup no Host; `KAMAL_REGISTRY_USERNAME` só precisa existir para o Kamal carregar a configuração.

O restore sem opções baixa o Backup diário mais recente e o verifica sem tocar a produção; `--from <object-key>` e `--target <DATABASE_URL|caminho>` escolhem objeto e destino (um destino explícito pede confirmação). Precauções no [README de Backup](../infra/backup/README.md#restore-e-verificação-de-restore). Em seguida, rode **Actions → Verificação de Restore → Run workflow** (ele também roda aos domingos) e confira o check de restore no Healthchecks.io.

## 8. Onde ver

- **Logs e métricas:** na tailnet, abra a URL HTTPS de `svc:ops` (Grafana) e filtre o dashboard Stack Ops pelo Produto.
- **Analytics:** em [Umami](https://analytics.dangus-box.com), abra o site do Produto e confirme as visitas e os eventos.
- **Flags:** na tailnet, abra a URL HTTPS de `svc:flags-admin`. No projeto `default`, crie Flags com prefixo `<produto>.` e constraint `appName IN ["<produto>"]` em todas as estratégias de `production` ([Flags na Stack Ops](../infra/ops/README.md#flags)). Teste kill switch, rollout, targeting e Remote Config (variantes com payload) na App.
- **Alertas:** no Telegram chegam Backup/restore atrasados (Healthchecks.io), uptime da API e da web e disco do Host acima de 85% ([alertas](../infra/ops/README.md#alertas)).

## Se travar

Execute `bun run dangus doctor` e revise as mensagens. Se persistir, abra uma issue em [Dangus-Box/dangus-platform](https://github.com/Dangus-Box/dangus-platform/issues) com o passo e a mensagem, sem secrets.

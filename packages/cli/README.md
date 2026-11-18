# Adoção de um Produto

Na raiz de um Produto com Apps em `apps/api`, `apps/web` ou `apps/mobile` e `drizzle.config.ts` com dialect `sqlite` ou `postgresql`, execute `dangus init`. Confirme as Apps e o Banco do Produto detectados. Para CI, use `dangus init --yes`: arquivos diferentes são preservados sem pergunta. O comando instala as dependências fixadas, gera a Config do Produto, Dockerfiles para as Apps de servidor (com um `.dockerignore` que mantém `.env`, `.git`, `node_modules` e bancos SQLite locais fora das imagens) e o workflow de deploy, e inclui `.dangus/` no `.gitignore`. Revise os domínios gerados e aplique manualmente as linhas de integração exibidas; consulte os READMEs dos SDKs para os detalhes. O comando não edita o código das Apps; ao final, indica `dangus register`, a segunda parte da Adoção, que faz o Registro na Stack Ops (veja abaixo). O workflow de Verificação de Restore será acrescentado na issue #23.

# Provisionamento do Host

O comando `dangus host bootstrap <usuario@host>` prepara um Host Ubuntu 24.04 via SSH. Ele exige `ssh`, `sudo` sem prompt no Host, `bws`, acesso ao BWS por `BWS_ACCESS_TOKEN` e uma chave pública SSH já autorizada. Guarde a chave de autenticação do Tailscale como secret no projeto `ops` e informe seu ID por `DANGUS_TAILSCALE_BWS_SECRET_ID`; o CLI lê o valor do BWS no momento da execução e o transmite pela entrada protegida da conexão SSH, sem gravá-lo no repositório.

```bash
export BWS_ACCESS_TOKEN='<token-do-bws>'
export DANGUS_TAILSCALE_BWS_SECRET_ID='<id-do-secret>'
dangus host bootstrap root@host
```

Antes de executar, confira o acesso de emergência pelo Browser terminal da Hostinger e confirme que o operador está conectado à tailnet. O provisionamento fecha o SSH público; execuções posteriores devem usar o endereço Tailscale. Configure o firewall da Hostinger seguindo [as instruções de infraestrutura](../../infra/tofu/README.md), pois o provider atual não o configura. Confirme o SSH pela tailnet e teste externamente que os endereços públicos IPv4 e IPv6 não respondem na porta 22. No ufw, apenas 80/tcp e 443/tcp ficam públicos; a interface `tailscale0` aceita todas as portas, pois a tailnet é a rede administrativa (ADR-0009). Se o ufw tiver regras diferentes dessas, o provisionamento lista as que serão descartadas e então redefine o ufw. Um Docker já instalado, como o `docker-ce` do repositório oficial, é mantido; o `docker.io` só é instalado quando não há Docker no Host.

O Alloy envia logs e métricas para a Stack Ops pela rede Docker `kamal`. As APIs deployadas pelo CLI anunciam `/metrics` pelas labels Docker `prometheus.io.scrape=true` e `prometheus.io.port=3000`. O timer de limpeza remove imagens não utilizadas com mais de sete dias.

Para exercitar o provisionamento localmente, execute `packages/cli/test/bootstrap-container.sh` com Docker. O teste cria um container privilegiado descartável com systemd, usa o driver Docker `vfs` para permitir Docker aninhado e pula apenas a entrada real na tailnet (`DANGUS_TEST_SKIP_TAILSCALE_JOIN=1`, recusado fora de container). Ele verifica as regras locais, os serviços e a segunda execução; a conectividade pública, a entrada real na tailnet e o Browser terminal precisam de um Host real.

# Config do Produto

Depois de `dangus init`, revise os domínios da Config do Produto e execute `dangus register` na raiz do Produto. O comando verifica primeiro se o Tailscale está conectado e usa o sufixo MagicDNS da tailnet para acessar o Unleash admin. Ele cria ou reconhece os cadastros do Produto no Umami, Unleash, Healthchecks.io e Cloudflare, grava os secrets no projeto `prod` do BWS e acrescenta as URLs públicas ao KV do Worker de uptime. Uma nova execução não altera cadastros já corretos; divergências ou duplicatas interrompem o comando para revisão. Um secret `<produto>__*` já presente no BWS sem o cadastro correspondente, como um ping URL configurado manualmente, também interrompe o comando antes de criar o cadastro, para evitar duplicatas. Com Docker, `infra/ops/test/register-e2e.sh` exercita o Registro contra Unleash, Edge e Umami descartáveis.

No Unleash OSS, os tokens `<produto>-backend` e `<produto>-frontend` são individuais e pertencem ao projeto compartilhado `default`, no Ambiente `production`. O prefixo das Flags e suas constraints de `appName` seguem a convenção descrita em `infra/ops/README.md`; essa convenção não impede um Produto de acessar dados de outro.

Instale `tailscale` e `bws`, conecte o Tailscale e use `BWS_ACCESS_TOKEN` de uma conta `operator` com leitura no projeto `ops` e escrita em `prod`. O projeto `ops` deve conter `ops__UMAMI_ADMIN_PASSWORD`, `ops__UNLEASH_ADMIN_PASSWORD`, `platform__HEALTHCHECKS_API_KEY` com escrita, `platform__CLOUDFLARE_DNS_TOKEN`, `platform__CLOUDFLARE_ZONE_ID`, `platform__CLOUDFLARE_ACCOUNT_ID` e `platform__CLOUDFLARE_R2_TOKEN` com permissão de edição do Workers KV. Configure previamente a integração Telegram no projeto do Healthchecks.io. Os IPs A e AAAA vêm do DNS de `analytics.dangus-box.com`; os domínios das Apps precisam pertencer à zona informada. O BWS CLI recebe valores nos argumentos ao criar secrets; execute em uma máquina confiável sem outros usuários locais.

Crie `dangus.config.ts` na raiz do repositório do Produto:

```ts
import { defineConfig } from "@dangus-box/cli";

export default defineConfig({
  name: "produto",
  apps: {
    api: { domain: "api.produto.com", memoryMb: 1024 },
    web: { domain: "web.produto.com" },
  },
  database: "postgres",
  deployTimeoutSeconds: 120,
  logger: { redact: ["token"] },
  backup: { destination: "r2" },
});
```

O `name` usa apenas letras minúsculas, números e hífens. Declare ao menos uma das Apps `api`, `web` e `mobile`; cada App declarada precisa de um domínio com um único nível de subdomínio, como `api-staging.produto.com`. O limite `memoryMb` (inteiro, em MB) tem padrão de 512 MB por App. O banco aceita `postgres` ou `sqlite`; `deployTimeoutSeconds` é o timeout de deploy em segundos (inteiro). `logger.redact` acrescenta campos para redaction e tem padrão vazio. O destino do Backup tem padrão `r2`; use `s3` para AWS S3 em `sa-east-1`.

Os campos opcionais de layout são:

| Campo | Padrão | Uso |
| --- | --- | --- |
| `apps.<app>.path` | `apps/<app>` | Base dos padrões de Dockerfile e entry |
| `apps.<app>.dockerfile` | `<path>/Dockerfile` | Dockerfile usado pelo builder |
| `apps.<app>.target` | ausente | Target do build, com letras, números, `_`, `.` e `-` |
| `apps.<app>.entry` | `<path>/index.ts` | Arquivo de integração lido pelo doctor para a API |
| `apps.<app>.healthcheckPath` | `/ready` na API, `/` nas demais | Healthcheck do proxy e URL de uptime das Apps de servidor |
| `migrations` | `drizzle` | Diretório de migrations SQL lido pelo doctor |

Caminhos usam `/`, são relativos à raiz do Produto e não aceitam segmentos `..`. Mesmo com `path` definido, `dockerfile` e `entry` explícitos partem da raiz. `healthcheckPath` deve começar com `/`; campos desconhecidos continuam sendo erro. Os padrões de render permanecem iguais ([ADR-0016](../../docs/adr/0016-layout-configuravel.md)).

## Adoção manual de um Produto com layout próprio

O `init` continua detectando apenas as convenções `apps/api`, `apps/web` e `apps/mobile`. Para outro layout, siga a [Adoção manual no Guia](../../docs/guide.md#adoção-manual-de-um-produto-com-layout-próprio): instale o CLI e os SDKs necessários, escreva a Config do Produto e forneça os Dockerfiles e workflows.

Por exemplo, para uma API em `backend/src/main.ts`:

```ts
export default defineConfig({
  name: "produto",
  apps: {
    api: {
      domain: "api.produto.com",
      path: "backend",
      dockerfile: "docker/api.Dockerfile",
      target: "production",
      entry: "backend/src/main.ts",
      healthcheckPath: "/health/ready",
    },
  },
  migrations: "database/migrations",
  database: "postgres",
  deployTimeoutSeconds: 120,
});
```

O Dockerfile continua usando a raiz do Produto como contexto e expondo a porta 3000. A App deve implementar o endpoint declarado e executar migrations do diretório correto antes de atender requisições; a Config não altera o código da App.

O CLI pode carregar e validar a Config do Produto com `loadConfig(diretorio)`, que usa o diretório atual por padrão. Erros identificam o caminho do campo inválido.

# Render e deploy de Apps

Execute `dangus render` na raiz do Produto para imprimir o `deploy.yml` de cada App de servidor. `dangus deploy` gera esses arquivos em uma pasta temporária, usa a imagem oficial do Kamal 2.12.0 fixada e remove a pasta ao terminar; mobile não participa. O Host padrão é `devbox-1` na tailnet; `DANGUS_HOST` substitui esse nome. O proxy publica nos IPs dos registros A e AAAA do domínio de cada App, que devem apontar para o Host em modo DNS-only; como o proxy é um só por Host e o Kamal não reconfigura um proxy já em execução, o render falha se as Apps resolverem para IPs diferentes. Use `DANGUS_PROXY_BIND_IPS` para substituí-los por IPs separados por vírgula. O deploy exige Docker, `bws` autenticado por `BWS_ACCESS_TOKEN`, SSH agent (`SSH_AUTH_SOCK`) e `KAMAL_REGISTRY_USERNAME` e `KAMAL_REGISTRY_PASSWORD` para o GHCR. Cada App precisa do Dockerfile declarado (padrão `apps/<app>/Dockerfile`), com contexto na raiz do Produto e porta 3000; deve responder no `healthcheckPath` declarado (padrão `/ready` na API e `/` na web).

Declare `secrets: ["CHAVE"]` em cada App; o CLI busca `<produto>__<CHAVE>` no BWS e passa o valor ao Kamal pelo ambiente, sem gravá-lo no `deploy.yml` ou nos argumentos. Nomes que controlam o deploy ou que a Plataforma fornece são recusados: `KAMAL_*`, `DOCKER_*`, `PATH`, `HOME`, `SSH_AUTH_SOCK`, `DATABASE_URL`, `POSTGRES_PASSWORD` e `SQLITE_PATH`. Postgres requer `<produto>__POSTGRES_PASSWORD`; o CLI fornece `DATABASE_URL` à API e mantém o Banco do Produto na rede interna. Para SQLite, a API deve usar `SQLITE_PATH` para o arquivo persistente. O adaptador `bitwarden-sm` não é usado diretamente porque a [imagem oficial do Kamal não inclui os CLIs dos gerenciadores de secrets](https://kamal-deploy.org/docs/installation/dockerized/).

Nos exemplos deste monorepo, execute `DANGUS_BUILD_CONTEXT=../.. dangus render` ou `DANGUS_BUILD_CONTEXT=../.. dangus deploy`, pois eles consomem `packages/server` fora da raiz do Produto. Os Dockerfiles dos exemplos pressupõem esse contexto; em Produtos independentes não defina essa variável.

## Doctor

Na raiz do Produto, execute `dangus doctor` antes do deploy, inclusive no CI. O comando verifica a integração da API no `entry` declarado (padrão `apps/api/index.ts`), a versão exata do CLI em `bun.lock` (instale com `bun add --dev --exact @dangus-box/cli`), a conexão com Tailscale e as migrations SQL no diretório `migrations` (padrão `drizzle/`). Ele retorna código 1 para falhas; avisos não impedem o deploy. Instale e conecte o Tailscale também no ambiente de CI.

O lint considera novas as migrations cujos caminhos não existem na ref Git `origin/main`. Garanta que a ref esteja disponível no CI, ou informe a ref que representa o estado deployado com `dangus doctor --base <ref>`. Arquivos já existentes nessa ref não são analisados, mesmo se alterados.

# Desenvolvimento local e inventário

Na raiz do Produto, execute `dangus dev` para iniciar `bun run dev` com `NODE_ENV=development`, que ativa os logs formatados de `@dangus-box/server`. Para Postgres, o comando inicia somente o Banco do Produto via Docker Compose na porta local 55432 e o para quando a App termina, inclusive por Ctrl-C ou SIGTERM; os dados ficam num volume Docker por diretório do Produto e persistem entre execuções. Para SQLite, não inicia containers. `DANGUS_DEV_POSTGRES_PORT` altera a porta local e `DATABASE_URL` pode substituir a conexão padrão. O comando define `DANGUS_DEV=1` para os futuros SDKs de analytics e Flags usarem modo no-op ou valores padrão; eles ainda não estão implementados.

Execute `dangus ls` para consultar, por SSH no Host `DANGUS_HOST` (padrão `devbox-1`), as labels Docker `product` e `app` dos containers em execução, mostrando só as Apps `api` e `web` (sem o proxy da Plataforma nem o Banco do Produto). O inventário vem do próprio Host, sem registro central.

# Workflow de deploy

O arquivo `templates/deploy.yml` é a base para um repositório de Produto independente. A cópia em `.github/workflows/deploy-example.yml` usa o Produto de exemplo Postgres e o lockfile deste monorepo. O `dangus init` copia esse arquivo para o Produto. O Produto deve fixar `@dangus-box/cli` e guardar seu lockfile: o workflow instala o CLI do commit escolhido. Push na `main` faz o Kamal construir e publicar as imagens no GHCR. Em `Actions → Deploy → Run workflow`, informe o SHA completo de um commit anterior da `main` para restaurar a Config do Produto e o CLI daquele commit. O CLI verifica todas as imagens `ghcr.io/dangus-box/<produto>-<app>:<sha>` antes de iniciar o deploy; caso alguma falte, falha sem reconstruir. O rollback exige um commit cujo CLI já suporte a `deploy --skip-build`; o comando falha em versões anteriores em vez de reconstruir.

Configure apenas o secret `BWS_ACCESS_TOKEN` no GitHub, com acesso aos projetos `ops` e `prod`. No BWS, configure `platform__TAILSCALE_OAUTH_CLIENT_ID` e `platform__TAILSCALE_OAUTH_CLIENT_SECRET` no projeto `ops`, com permissão para a tag `tag:ci`; configure também `platform__DEPLOY_SSH_PRIVATE_KEY` e `platform__DEPLOY_SSH_KNOWN_HOSTS` com a chave privada autorizada no Host e a identidade SSH do Host verificada fora do workflow. A variável opcional `DANGUS_HOST` no GitHub seleciona o nome do Host na tailnet; sem ela, o CLI usa `devbox-1`. Configure o GHCR para que `GITHUB_TOKEN` possa publicar e ler as imagens do Produto. Secrets das Apps continuam no BWS conforme descrito acima.

Antes de usar com um Host real, verifique no GitHub: permissões do `GITHUB_TOKEN` e acesso aos pacotes GHCR; acesso do token BWS aos projetos necessários; OAuth, tag e regras da tailnet para o nó efêmero; chave SSH autorizada e identidade do Host; domínio e configuração do Produto. Execute um push na `main` e confirme imagens por SHA no GHCR, conexão efêmera, deploy e healthchecks das Apps. Depois publique outro commit e execute o workflow manual com o SHA anterior: confirme nos logs que não houve build ou push, que as imagens anteriores foram usadas e que a versão e configuração anteriores estão em execução. Confira que execuções concorrentes não se sobrepõem e que nenhum valor de secret aparece nos logs. Esses passos exigem GitHub, GHCR, BWS, tailnet e Host reais; os testes locais não os exercitam. Para emergência, `kamal rollback` continua disponível, mas não restaura a configuração gerada pelo CLI anterior (ADR-0013).

Cada App também pode declarar argumentos públicos de build, secrets de build e variáveis em claro:

```ts
web: {
  domain: "web.produto.com",
  build: {
    args: { PUBLIC_URL: "https://web.produto.com" },
    secrets: ["SSH_KEY"],
  },
  env: { NODE_ENV: "production" },
  secrets: ["SESSION_KEY"],
},
```

`build.args` vira `builder.args` no Kamal; `env` vira `env.clear`. Esses valores são públicos: não coloque credenciais neles. Os nomes seguem `^[A-Z][A-Z0-9_]*$`, e os valores de `env` devem ser strings sem quebras de linha. A mesma chave não pode aparecer em variáveis em claro e secrets da App, nem em argumentos públicos e secrets. `APP_VERSION` é reservado: a Plataforma injeta o SHA completo do commit do Produto como argumento de build e variável em claro da App, inclusive no rollback com `--skip-build`. O Dockerfile precisa declarar `ARG APP_VERSION` para consumi-lo durante o build.

`build.secrets` vira `builder.secrets`. O CLI busca `<produto>__SSH_KEY` no BWS apenas quando há build, mantém a referência `SSH_KEY=$SSH_KEY` em `.kamal/secrets` e passa `-e SSH_KEY` ao container Kamal; o valor segue pelo ambiente, preservando quebras de linha de uma chave SSH. Consuma no Dockerfile com BuildKit, por exemplo `RUN --mount=type=secret,id=SSH_KEY ...`; não copie o secret para a imagem. As restrições de nomes reservados dos secrets de execução também se aplicam aos secrets de build. Se um nome estiver nas duas listas, ele é buscado uma única vez; no `--skip-build`, só continua sendo necessário se também for secret de execução. `dangus render` mostra os nomes dos secrets e o SHA, sem consultar o BWS nem exibir valores de secrets.

Para verificar a leitura de secrets multilinha pela imagem fixada do Kamal, execute `DANGUS_TEST_KAMAL=1 bun test packages/cli/src/deploy.test.ts` com Docker disponível.

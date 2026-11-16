# Provisionamento do Host

O comando `dangus host bootstrap <usuario@host>` prepara um Host Ubuntu 24.04 via SSH. Ele exige `ssh`, `sudo` sem prompt no Host, `bws`, acesso ao BWS por `BWS_ACCESS_TOKEN` e uma chave pública SSH já autorizada. Guarde a chave de autenticação do Tailscale como secret no projeto `ops` e informe seu ID por `DANGUS_TAILSCALE_BWS_SECRET_ID`; o CLI lê o valor do BWS no momento da execução e o transmite pela entrada protegida da conexão SSH, sem gravá-lo no repositório.

```bash
export BWS_ACCESS_TOKEN='<token-do-bws>'
export DANGUS_TAILSCALE_BWS_SECRET_ID='<id-do-secret>'
dangus host bootstrap root@host
```

Antes de executar, confira o acesso de emergência pelo Browser terminal da Hostinger e confirme que o operador está conectado à tailnet. O provisionamento fecha o SSH público; execuções posteriores devem usar o endereço Tailscale. Configure o firewall da Hostinger seguindo [as instruções de infraestrutura](../../infra/tofu/README.md), pois o provider atual não o configura. Confirme o SSH pela tailnet e teste externamente que os endereços públicos IPv4 e IPv6 não respondem na porta 22. No ufw, apenas 80/tcp e 443/tcp ficam públicos; a interface `tailscale0` aceita todas as portas, pois a tailnet é a rede administrativa (ADR-0009). Se o ufw tiver regras diferentes dessas, o provisionamento lista as que serão descartadas e então redefine o ufw. Um Docker já instalado, como o `docker-ce` do repositório oficial, é mantido; o `docker.io` só é instalado quando não há Docker no Host.

O Alloy começa sem destino remoto. Containers que disponibilizam métricas devem ter as labels Docker `prometheus.io.scrape=true` e `prometheus.io.port=<porta>`; o endpoint é `/metrics`. O Alloy coleta logs e métricas, mas as descarta até que um destino seja configurado em trabalho futuro. O timer de limpeza remove imagens não utilizadas com mais de sete dias.

Para exercitar o provisionamento localmente, execute `packages/cli/test/bootstrap-container.sh` com Docker. O teste cria um container privilegiado descartável com systemd, usa o driver Docker `vfs` para permitir Docker aninhado e pula apenas a entrada real na tailnet (`DANGUS_TEST_SKIP_TAILSCALE_JOIN=1`, recusado fora de container). Ele verifica as regras locais, os serviços e a segunda execução; a conectividade pública, a entrada real na tailnet e o Browser terminal precisam de um Host real.

# Config do Produto

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

O CLI pode carregar e validar a Config do Produto com `loadConfig(diretorio)`, que usa o diretório atual por padrão. Erros identificam o caminho do campo inválido.

# Render e deploy de Apps

Execute `dangus render` na raiz do Produto para imprimir o `deploy.yml` de cada App de servidor. `dangus deploy` gera esses arquivos em uma pasta temporária, usa a imagem oficial do Kamal 2.12.0 fixada e remove a pasta ao terminar; mobile não participa. O Host padrão é `devbox-1` na tailnet; `DANGUS_HOST` substitui esse nome. O proxy publica nos IPs dos registros A e AAAA do domínio de cada App, que devem apontar para o Host em modo DNS-only; como o proxy é um só por Host e o Kamal não reconfigura um proxy já em execução, o render falha se as Apps resolverem para IPs diferentes. Use `DANGUS_PROXY_BIND_IPS` para substituí-los por IPs separados por vírgula. O deploy exige Docker, `bws` autenticado por `BWS_ACCESS_TOKEN`, SSH agent (`SSH_AUTH_SOCK`) e `KAMAL_REGISTRY_USERNAME` e `KAMAL_REGISTRY_PASSWORD` para o GHCR. Cada App precisa de `apps/<app>/Dockerfile`, com contexto na raiz do Produto e porta 3000; a API deve responder em `/ready` e a web em `/`.

Declare `secrets: ["CHAVE"]` em cada App; o CLI busca `<produto>__<CHAVE>` no BWS e passa o valor ao Kamal pelo ambiente, sem gravá-lo no `deploy.yml` ou nos argumentos. Nomes que controlam o deploy ou que a Plataforma fornece são recusados: `KAMAL_*`, `DOCKER_*`, `PATH`, `HOME`, `SSH_AUTH_SOCK`, `DATABASE_URL`, `POSTGRES_PASSWORD` e `SQLITE_PATH`. Postgres requer `<produto>__POSTGRES_PASSWORD`; o CLI fornece `DATABASE_URL` à API e mantém o Banco do Produto na rede interna. Para SQLite, a API deve usar `SQLITE_PATH` para o arquivo persistente. O adaptador `bitwarden-sm` não é usado diretamente porque a [imagem oficial do Kamal não inclui os CLIs dos gerenciadores de secrets](https://kamal-deploy.org/docs/installation/dockerized/).

Nos exemplos deste monorepo, execute `DANGUS_BUILD_CONTEXT=../.. dangus render` ou `DANGUS_BUILD_CONTEXT=../.. dangus deploy`, pois eles consomem `packages/server` fora da raiz do Produto. Os Dockerfiles dos exemplos pressupõem esse contexto; em Produtos independentes não defina essa variável.

## Doctor

Na raiz do Produto, execute `dangus doctor` antes do deploy, inclusive no CI. O comando verifica a integração da API em `apps/api/index.ts`, a versão exata do CLI em `bun.lock` (instale com `bun add --dev --exact @dangus-box/cli`), a conexão com Tailscale e as migrations SQL em `drizzle/`. Ele retorna código 1 para falhas; avisos não impedem o deploy. Instale e conecte o Tailscale também no ambiente de CI.

O lint considera novas as migrations cujos caminhos não existem na ref Git `origin/main`. Garanta que a ref esteja disponível no CI, ou informe a ref que representa o estado deployado com `dangus doctor --base <ref>`. Arquivos já existentes nessa ref não são analisados, mesmo se alterados.

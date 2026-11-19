# @dangus-box/cli

## 2.0.0-rc.1

### Patch Changes

- aa0e0d8: O doctor aceita como expand o `ALTER TABLE` que troca um CHECK: `DROP CONSTRAINT <nome>` seguido, no mesmo statement, de `ADD CONSTRAINT <mesmo nome> CHECK (...)` (com `NOT VALID` opcional), e `VALIDATE CONSTRAINT` não é sinalizado. Emite um aviso lembrando que o CHECK só pode ampliar, pois o linter não consegue provar isso. Qualquer outro `DROP` (coluna, tabela, constraint sem o mesmo nome, re-adição que não seja CHECK) continua falhando.

## 2.0.0-rc.0

### Mudanças incompatíveis

- Atualiza o CLI para o Kit de Integração 2.0, com mudanças incompatíveis para Produtos existentes:

  - Banco do Produto, desenvolvimento e restore passam a usar Postgres 18.1; o volume agora é montado em `/var/lib/postgresql`, com dados em `/var/lib/postgresql/18/docker`. A troca de major exige dump/restore manual em volume novo. O deploy usa a imagem de Backup 1.1.0, que deve estar publicada antes da Adoção.
  - O doctor exige migrations do Drizzle 1.0 em `<migrations>/<timestamp>_<nome>/migration.sql`, rejeita SQL plano do Drizzle 0.x e ignora pastas já presentes na ref base. Converta as migrations com `drizzle-kit up` e preserve as já aplicadas.
  - O workflow de deploy gerado executa `dangus doctor --base HEAD^` antes do deploy, usa checkout com dois commits e aceita `workflow_call` com SHA opcional para encadear o deploy ao CI do Produto. Rollback com SHA completo dispensa doctor e build; regenere ou adapte o workflow existente.
  - A Config do Produto permite substituir `path`, `dockerfile`, `target`, `entry`, `migrations` e `healthcheckPath` por App, preservando os padrões anteriores.
  - `build.secrets` usa secrets do BWS somente quando há build; `build.args` define argumentos públicos e `env` define variáveis em claro. `APP_VERSION` é reservado e recebe o SHA no build e na execução; nomes e colisões são validados.
  - O Registro na Stack Ops descobre a zona Cloudflare do domínio próprio de cada Produto e cria apenas A/AAAA ausentes em DNS-only. Zonas não ativas e conflitos impedem a escrita. Substitua o token DNS por um com `Zone:DNS:Edit` e `Zone:Zone:Read` em “All zones from an account” na conta da Plataforma, atualize `platform__CLOUDFLARE_DNS_TOKEN` no BWS e revogue o anterior; `platform__CLOUDFLARE_ZONE_ID` deixa de ser necessário.

## 1.0.0

### Major Changes

- 43de60c: Primeira publicação pública do Kit de Integração.

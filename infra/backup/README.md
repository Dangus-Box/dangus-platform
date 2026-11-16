# Backup diário

A imagem `ghcr.io/dangus-box/backup:1.0.0` executa às 03:00 UTC. Cada execução gera um arquivo comprimido e criptografado com a chave pública age; grava em `daily/`, também em `weekly/` aos domingos e em `monthly/` no dia 1, em UTC. O bucket aplica a retenção de cada prefixo. A chave privada permanece no BWS e não é fornecida ao Host.

Antes do deploy, gere o par de chaves com `generate-age-key.sh`: a chave pública fica no BWS como `ops__BACKUP_AGE_PUBLIC_KEY`, e o `dangus deploy` e o deploy da Stack Ops a leem de lá como os demais secrets. Assim, Produtos fazem deploy do próprio repositório sem precisar de `infra/backup/age.pub`. Configure no BWS `ops__R2_BACKUP_ACCESS_KEY_ID`, `ops__R2_BACKUP_SECRET_ACCESS_KEY`, `platform__R2_ENDPOINT` e `<produto>__HEALTHCHECKS_BACKUP_URL`; para a Stack Ops use `ops__HEALTHCHECKS_BACKUP_URL`. Configure no Healthchecks.io um período diário e a integração com Telegram.

Para executar agora, rode `dangus db backup` no diretório do Produto com acesso SSH ao Host. O teste local `infra/backup/tests/e2e.sh` cria containers descartáveis e uma identidade age de teste; não usa credenciais reais.

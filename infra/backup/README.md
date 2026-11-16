# Backup diário

A imagem `ghcr.io/dangus-box/backup:1.0.0` executa às 03:00 UTC. Cada execução gera um arquivo comprimido e criptografado com a chave pública age; grava em `daily/`, também em `weekly/` aos domingos e em `monthly/` no dia 1, em UTC. O bucket aplica a retenção de cada prefixo. A chave privada permanece no BWS e não é fornecida ao Host.

Antes do deploy, gere o par de chaves com `generate-age-key.sh`: a chave pública fica no BWS como `ops__BACKUP_AGE_PUBLIC_KEY`, e o `dangus deploy` e o deploy da Stack Ops a leem de lá como os demais secrets. Assim, Produtos fazem deploy do próprio repositório sem precisar de `infra/backup/age.pub`. Configure no BWS `ops__R2_BACKUP_ACCESS_KEY_ID`, `ops__R2_BACKUP_SECRET_ACCESS_KEY`, `platform__R2_ENDPOINT` e `<produto>__HEALTHCHECKS_BACKUP_URL`; para a Stack Ops use `ops__HEALTHCHECKS_BACKUP_URL`. Configure no Healthchecks.io um período diário e a integração com Telegram.

Para executar agora, rode `dangus db backup` no diretório do Produto com acesso SSH ao Host. O teste local `infra/backup/tests/e2e.sh` cria containers descartáveis e uma identidade age de teste; não usa credenciais reais.

## Restore e Verificação de Restore

No diretório do Produto, `dangus db restore` restaura o Backup diário mais recente em um destino local descartável; `--from <object-key>` escolhe outro objeto e `--target <DATABASE_URL|caminho>` escolhe um destino explícito, sujeito a confirmação (`--yes` dispensa a pergunta). O operador precisa de `bws`, `age`, `gzip`, `curl` e Docker; para um destino Postgres explícito também precisa de `psql`. A chave privada é lida do BWS apenas na máquina do operador, nunca no Host. Os arquivos temporários são removidos ao final.

O workflow semanal gerado pelo `dangus init` executa `dangus db restore --verify` e verifica o schema no Postgres ou `PRAGMA integrity_check` no SQLite. Configure `<produto>__HEALTHCHECKS_RESTORE_URL` no BWS e um check semanal com integração ao Telegram no Healthchecks.io, além de `BWS_ACCESS_TOKEN` nos secrets do GitHub. O workflow precisa acessar os secrets de Backup e o endpoint R2 no BWS. Ele reutiliza o token R2 existente do Host, que já permite leitura e listagem, evitando outro token para manter; a chave privada continua restrita ao BWS.

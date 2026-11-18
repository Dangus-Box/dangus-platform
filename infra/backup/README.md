# Backup diário

A imagem `ghcr.io/dangus-box/backup:1.1.0` executa às 03:00 UTC. Cada execução gera um arquivo comprimido e criptografado com a chave pública age; grava em `daily/`, também em `weekly/` aos domingos e em `monthly/` no dia 1, em UTC. O bucket aplica a retenção de cada prefixo. A chave privada permanece no BWS e não é fornecida ao Host.

Antes do deploy, gere o par de chaves com `generate-age-key.sh`: a chave pública fica no BWS como `ops__BACKUP_AGE_PUBLIC_KEY`, e o `dangus deploy` e o deploy da Stack Ops a leem de lá como os demais secrets. Assim, Produtos fazem deploy do próprio repositório sem precisar de `infra/backup/age.pub`. Configure no BWS `ops__R2_BACKUP_ACCESS_KEY_ID`, `ops__R2_BACKUP_SECRET_ACCESS_KEY`, `platform__R2_ENDPOINT` e `<produto>__HEALTHCHECKS_BACKUP_URL`; para a Stack Ops use `ops__HEALTHCHECKS_BACKUP_URL`. Configure no Healthchecks.io um período diário e a integração com Telegram.

Para executar agora, rode `dangus db backup` no diretório do Produto com acesso SSH ao Host. O teste local `infra/backup/tests/e2e.sh` cria containers descartáveis e uma identidade age de teste; não usa credenciais reais.

## Restore e Verificação de Restore

No diretório do Produto, `dangus db restore` restaura o Backup diário mais recente em um destino local descartável; `--from <object-key>` escolhe outro objeto e `--target <DATABASE_URL|caminho>` escolhe um destino explícito, sujeito a confirmação (`--yes` dispensa a pergunta). O destino Postgres é restaurado numa transação única: se falhar, nada é aplicado. Um destino SQLite com `-wal` é recusado; pare a App antes. O operador precisa de `bws`, `age`, `gzip`, `curl` e Docker; para um destino Postgres explícito também precisa de `psql` 18.1 ou mais novo, que entende o `\restrict` do dump. A chave privada é lida do BWS apenas na máquina do operador, nunca no Host. A chave vai ao `age` pelo stdin, sem tocar o disco; o dump decifrado e o container descartável são removidos ao final, inclusive em falha ou Ctrl-C.

O workflow semanal gerado pelo `dangus init` executa `dangus db restore --verify` e verifica o schema no Postgres ou `PRAGMA integrity_check` no SQLite. Configure `<produto>__HEALTHCHECKS_RESTORE_URL` no BWS e um check com período de 7 dias, tolerância de 1 dia e integração ao Telegram no Healthchecks.io, além de `BWS_ACCESS_TOKEN` nos secrets do GitHub. O workflow precisa acessar os secrets de Backup e o endpoint R2 no BWS. Ele reutiliza o token R2 existente do Host, que já permite leitura e listagem, evitando outro token para manter; a chave privada continua restrita ao BWS.

## Versão do Postgres e troca de major

O Banco do Produto, o desenvolvimento local, a imagem de Backup e a Verificação de Restore usam Postgres 18.1 fixado por digest. O volume do Banco do Produto monta `/var/lib/postgresql`; a imagem oficial define `PGDATA=/var/lib/postgresql/18/docker`. O teste Docker verifica esse caminho e a persistência após recriar o container. O `pg_dump` 18 também lê os bancos Postgres 16 da Stack Ops; essa compatibilidade permanece coberta pelo teste local.

Trocar a major de um Banco do Produto existente exige **dump/restore manual**, com interrupção planejada da App, Backup conferido, restauração em volume novo e validação antes de retomar o tráfego. Não basta mudar a imagem ou remontar o volume antigo: Postgres 18 não abre os arquivos de dados de outra major. O mesmo cuidado vale para o volume local de desenvolvimento. Preserve o volume anterior até concluir a validação.

A versão da imagem de Backup fica em `image/VERSION`. O workflow `backup-image.yml` publica essa tag somente após merge em `main`; não publique manualmente nem reutilize tags. A versão 1.1.0 precisa ser publicada antes de usar o CLI atualizado para deploy de um Produto. A Stack Ops mantém seus bancos em Postgres 16 e seus accessories atuais até uma atualização separada.

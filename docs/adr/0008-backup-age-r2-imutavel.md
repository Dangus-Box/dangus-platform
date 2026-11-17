# Backup diário criptografado com age em bucket R2 imutável, com Verificação de Restore semanal

Cada Banco do Produto, e cada banco da Stack Ops (Umami, Unleash, Grafana), recebe um dump diário (`pg_dump` para Postgres, `sqlite3 .backup` para SQLite, já que copiar o arquivo do SQLite em uso não é seguro). O dump é comprimido, criptografado com `age` e enviado ao Cloudflare R2 com nome único, em `daily/`, `weekly/` ou `monthly/`. O Host guarda só a chave pública do `age`. A chave privada fica apenas no BWS. Bucket locks do R2 por prefixo (7, 28 e 90 dias) impedem apagar um Backup antes do prazo, e regras de lifecycle apagam depois. Um job semanal no GitHub Actions faz a Verificação de Restore.

O objetivo é que nem um Host comprometido consiga apagar ou ler os Backups. O destino fica fora da Hostinger porque ela não tem object storage, e um Backup no mesmo provedor não protege contra perder a conta ou o datacenter. Escolhemos o R2 porque ele não cobra pela saída dos dados, e o restore é justamente quando mais se baixa.

## Considered Options

- **restic:** era a escolha inicial (criptografia, deduplicação e retenção prontas). Foi trocado porque o `forget`/`prune` do restic apaga e reescreve objetos, e ele cria e remove arquivos de lock próprios no bucket, o que é incompatível com bucket locks. Sem as travas, quem invadisse o Host poderia apagar os Backups com as credenciais que estão nele. A deduplicação perdida é irrelevante para bancos pequenos.

## Consequences

- O RPO aceito na v1 é de até 24 horas, tanto para Postgres quanto para SQLite. Replicação contínua (Litestream para SQLite, WAL-G ou pgBackRest para Postgres) é trabalho futuro.
- O job de Backup e a Verificação de Restore pingam um dead-man's switch no Healthchecks.io. Se pararem de rodar, o alerta chega sem esperar a próxima Verificação de Restore.
- Os dados ficam fora do Brasil. A LGPD permite isso com salvaguardas (a criptografia é uma delas). Um Produto com exigência contratual de manter os dados no país pode apontar para o AWS S3 `sa-east-1` na sua Config do Produto.
- Logs e métricas não têm Backup.

# Migrations Aditivas, executadas no boot da API

As migrations rodam quando o container da API inicia, antes de começar a atender requisições, protegidas por um advisory lock no Postgres. Elas precisam ser Migrations Aditivas (padrão expand/contract): renomear ou remover uma coluna vira dois deploys. O motivo é o deploy sem downtime do Kamal: o container novo sobe antes do antigo sair, então por alguns segundos as duas versões da App rodam contra o mesmo schema. Além disso, os hooks de pre-deploy do Kamal rodam na máquina do CI e não no Host, então não servem para migrar.

## Consequences

- O `dangus doctor` alerta quando encontra `DROP` ou `RENAME` em migrations novas. Também alerta para operações que são aditivas mas travam a tabela: `ALTER COLUMN TYPE`, `SET NOT NULL` e `CREATE INDEX` sem `CONCURRENTLY`.
- Uma migration lenta pode estourar o health check do `kamal-proxy` durante o deploy. O timeout de deploy é configurável na Config do Produto.
- O rollback não desfaz migrations e não precisa desfazer (ADR-0013).
- Um Produto que precise de uma migration destrutiva faz isso em dois deploys, de forma deliberada.

---
"@dangus-box/server": major
---

Atualiza o SDK para Drizzle 1.0: `drizzle-orm` passa a ser peer dependency `^1.0.0-rc.4` (desenvolvimento fixado em `1.0.0-rc.4`). Atualize o ORM e converta as migrations com `drizzle-kit up` para o formato pasta por migration antes de atualizar o SDK.

O migrator Postgres usa a API 1.0 sob advisory lock de sessão; SQLite lê as pastas oficiais sob `BEGIN IMMEDIATE`. O histórico existente é atualizado sem reaplicar migrations, mas ganha colunas: preserve todas as migrations aplicadas e faça Backup antes da atualização. Rollback de código não desfaz o schema nem esse upgrade do histórico.

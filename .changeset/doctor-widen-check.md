---
"@dangus-box/cli": patch
---

O doctor aceita como expand o `ALTER TABLE` que troca um CHECK: `DROP CONSTRAINT <nome>` seguido, no mesmo statement, de `ADD CONSTRAINT <mesmo nome> CHECK (...)` (com `NOT VALID` opcional), e `VALIDATE CONSTRAINT` não é sinalizado. Emite um aviso lembrando que o CHECK só pode ampliar, pois o linter não consegue provar isso. Qualquer outro `DROP` (coluna, tabela, constraint sem o mesmo nome, re-adição que não seja CHECK) continua falhando.

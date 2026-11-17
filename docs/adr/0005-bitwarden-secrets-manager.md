# Bitwarden Secrets Manager como fonte da verdade dos secrets

Os secrets vivem no Bitwarden Secrets Manager (BWS). O GitHub guarda apenas o token de acesso ao BWS. Não usamos GitHub Environments como fonte da verdade porque secrets do GitHub só podem ser gravados, nunca lidos de volta, e alguns secrets precisam ser lidos fora do CI, como a chave de criptografia dos Backups e as credenciais do R2 num restore feito da máquina de alguém. O Kamal tem adaptador nativo `bitwarden-sm`, então CI, deploy local e CLI buscam do mesmo lugar.

## Consequences

- No plano Free (2 usuários, 3 projetos, 3 machine accounts), os projetos são organizados por Ambiente (`prod`, `ops` e, futuramente, `staging`), e não por Produto. Os nomes seguem `<produto>__<CHAVE>`.
- Por isso, o token do CI consegue ler os secrets de todos os Produtos. Quando for preciso isolar por Produto, ou o time passar de 2 pessoas, migrar para o plano Teams.
- O BWS é um produto separado do gerenciador de senhas Bitwarden que o time já usa.
- Quando o Ambiente de staging chegar, ele consome o terceiro e último projeto do plano Free.
- O token de CI de qualquer Produto conseguir ler os secrets de todos os Produtos é um risco aceito conscientemente para um time de 1 a 3 pessoas, não um descuido.

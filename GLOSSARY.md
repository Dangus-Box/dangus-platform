# Dangus Platform

Facilitador que leva produtos da Dangus Box de um projeto já estruturado até produção com banco, backup, logs, métricas, analytics e feature flags, sem reconfigurar tudo do zero a cada produto.

## Plataforma

**Plataforma**:
O conjunto formado pela Stack Ops e pelo Kit de Integração, mantido neste repositório.
_Avoid_: core, boilerplate, template

**Stack Ops**:
Os serviços compartilhados que existem uma única vez e atendem todos os Produtos: observabilidade, analytics, feature flags e o destino dos backups.
_Avoid_: infra compartilhada, core, ops (sozinho)

**Kit de Integração**:
O que um Produto consome da Plataforma para ser deployado e se conectar à Stack Ops: o CLI e o SDK.
_Avoid_: boilerplate, template, starter

**Host**:
Um servidor virtual (VPS) gerenciado pela Plataforma.
_Avoid_: máquina, servidor, droplet, instância

**Host Ops**:
O Host onde roda a Stack Ops. Enquanto houver um único Host, ele é ao mesmo tempo Host Ops e Host de Apps.

**Host de Apps**:
O Host onde rodam as Apps dos Produtos.

## Produto

**Produto**:
Uma aplicação da Dangus Box que é colocada no ar através da Plataforma, com repositório próprio.
_Avoid_: projeto, cliente, sistema

**App**:
Uma unidade deployável ou distribuível dentro de um Produto: a API, o web ou o mobile.
_Avoid_: serviço, módulo, componente

**Config do Produto**:
A declaração, no repositório do Produto, do que ele precisa da Plataforma: Apps, tipo de banco, domínios, recursos e o que está ligado. É a fonte da verdade sobre o Produto.
_Avoid_: manifesto, settings

**Banco do Produto**:
O banco de dados exclusivo de um Produto, Postgres ou SQLite. Nunca é compartilhado entre Produtos.
_Avoid_: database compartilhado, schema do produto

**Ambiente**:
Uma cópia isolada de um Produto em execução, como produção ou staging.
_Avoid_: stage, env (em texto)

**Scaffold**:
A criação da estrutura inicial do repositório de um Produto. Acontece fora da Plataforma.
_Avoid_: init (são coisas diferentes)

**Adoção**:
O passo que torna um Produto já estruturado apto a ser deployado pela Plataforma, incluindo seu Registro na Stack Ops.
_Avoid_: onboarding, setup, scaffold

**Registro na Stack Ops**:
O cadastro de um Produto nos serviços da Stack Ops (analytics e feature flags), junto com a guarda das credenciais resultantes.
_Avoid_: provisionamento (reservado para Hosts)

**Provisionamento**:
A criação e preparação de um Host para receber a Plataforma.
_Avoid_: setup, bootstrap (em texto)

## Dados

**Backup**:
Uma cópia criptografada do Banco do Produto, ou de um banco da Stack Ops, guardada fora da Hostinger.
_Avoid_: snapshot, dump (o dump é só um passo do Backup)

**Verificação de Restore**:
A restauração periódica e automática do Backup mais recente num lugar descartável, para provar que ele funciona.
_Avoid_: teste de backup

**Migration Aditiva**:
Uma alteração de schema que mantém compatível o código da versão anterior da App, permitindo que as duas versões convivam durante o deploy.
_Avoid_: migration segura, migration não destrutiva

## Feature flags

**Flag**:
Uma decisão de comportamento de um Produto que pode ser mudada em produção sem deploy. Pode ser booleana ou carregar um valor (Remote Config).
_Avoid_: toggle, switch, feature toggle

**Remote Config**:
Uma Flag que carrega um valor não booleano, como um texto, um limite ou uma versão.
_Avoid_: config dinâmica, parâmetro remoto

**Versão Mínima**:
A menor versão do App mobile autorizada a rodar. Abaixo dela, o usuário é obrigado a atualizar. É uma Remote Config.
_Avoid_: force update, versão obrigatória

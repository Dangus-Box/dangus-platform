# Provisionamento do Host

Esta configuração gerencia o Host já existente, um VPS Hostinger KVM 4 no Brasil, e registra nele uma chave pública SSH. O Host não é criado aqui: ele entra no state uma única vez por `tofu import`. A configuração impede destruí-lo (`prevent_destroy`), porque destruir cancela a assinatura. Ela também ignora mudanças em plano, datacenter, senha, template e script de pós-instalação: as três primeiras forçariam a recriação do Host, e as duas últimas reinstalariam o sistema. O state usa o bucket R2 dedicado `dangus-tofu-state`, com criptografia AES-GCM nativa do OpenTofu. O mesmo state também contém o bucket R2 de Backups, seus locks, lifecycle e token do Host.

## Pré-requisitos

- OpenTofu 1.10 ou posterior (menor que 2.0), `bws` e `jq`.
- Conta Hostinger com acesso à API e o Host já contratado.
- Bucket R2 privado `dangus-tofu-state` já criado na conta Cloudflare, antes de `tofu init`: um backend não pode criar seu próprio bucket. As credenciais R2 precisam permitir leitura, escrita e listagem desse bucket. A criação do bucket é uma etapa separada, sujeita a autorização.
- Acesso ao projeto `ops` do BWS com `BWS_ACCESS_TOKEN`. Crie nele o secret `platform__TOFU_STATE_PASSPHRASE` com uma frase aleatória forte de pelo menos 16 caracteres e preserve-a: perdê-la impede a leitura do state. Não troque a frase sem seguir o procedimento de rotação de chaves do OpenTofu.
- Os secrets existentes no projeto `ops`: `platform__HOSTINGER_API_TOKEN`, `platform__CLOUDFLARE_ACCOUNT_ID`, `platform__CLOUDFLARE_ZONE_ID`, `platform__CLOUDFLARE_DNS_TOKEN`, `platform__CLOUDFLARE_R2_TOKEN`, `platform__R2_ACCESS_KEY_ID`, `platform__R2_SECRET_ACCESS_KEY` e `platform__R2_ENDPOINT`. O token Cloudflare usado pelo provider precisa gerenciar o bucket R2, locks, lifecycle e tokens de API; confirme as permissões antes de aplicar. As credenciais S3 do backend são distintas das credenciais de Backup.

## Execução

No shell, obtenha o ID do projeto `ops` com `bws project list` e configure-o sem gravar secrets em arquivos. A função exige exatamente um secret com o nome informado no projeto:

```bash
cd infra/tofu
export OPS_PROJECT_ID="<id-do-projeto-ops>"
secret() {
  local id
  id=$(bws secret list "$OPS_PROJECT_ID" | jq -er --arg key "$1" '[.[] | select(.key == $key) | .id] | if length == 1 then .[0] else error("secret ausente ou duplicado") end') || return 1
  bws secret get "$id" | jq -er '.value'
}
export HOSTINGER_API_TOKEN="$(secret platform__HOSTINGER_API_TOKEN)"
export CLOUDFLARE_API_TOKEN="$(secret platform__CLOUDFLARE_R2_TOKEN)"
export TF_VAR_cloudflare_account_id="$(secret platform__CLOUDFLARE_ACCOUNT_ID)"
export AWS_ACCESS_KEY_ID="$(secret platform__R2_ACCESS_KEY_ID)"
export AWS_SECRET_ACCESS_KEY="$(secret platform__R2_SECRET_ACCESS_KEY)"
export AWS_ENDPOINT_URL_S3="$(secret platform__R2_ENDPOINT)"
export TF_VAR_state_passphrase="$(secret platform__TOFU_STATE_PASSPHRASE)"
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
```

Confira que todos os valores foram carregados sem imprimi-los; com `AWS_ENDPOINT_URL_S3` vazio, o backend tentaria a AWS em vez do R2:

```bash
for v in HOSTINGER_API_TOKEN CLOUDFLARE_API_TOKEN TF_VAR_cloudflare_account_id AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL_S3 TF_VAR_state_passphrase; do
  [ -n "${!v}" ] || echo "faltando: $v"
done
```
 Descubra o ID do Host existente, o ID do seu datacenter e o do seu template pela API da Hostinger (ou no hPanel), conferindo pelo IPv4 público. Os IDs de datacenter e template precisam ser os do Host: a configuração recusa um datacenter que o catálogo não identifica como brasileiro. Informe também a chave pública SSH a registrar; nunca a chave privada.

```bash
curl -fsS -H "Authorization: Bearer $HOSTINGER_API_TOKEN" https://developers.hostinger.com/api/vps/v1/virtual-machines \
  | jq '.[] | {id, hostname, ipv4: [.ipv4[].address], template, data_center}'
export VPS_ID="<id-do-host>"
export TF_VAR_data_center_id="<id-do-datacenter-do-host>"
export TF_VAR_template_id="<id-do-template-do-host>"
export TF_VAR_ssh_public_key="$(cat ~/.ssh/id_ed25519.pub)"
```

### Primeira execução

1. Crie o bucket R2 e o secret `platform__TOFU_STATE_PASSPHRASE` (ver Pré-requisitos) e carregue as variáveis acima.
2. `tofu init`
3. `tofu import hostinger_vps.host "$VPS_ID"`, só uma vez: o Host passa a constar do state criptografado no R2.
4. `tofu plan`. O resultado esperado é `1 to add, 1 to change, 0 to destroy`: criar `hostinger_vps_ssh_key.host` e anexá-la ao Host (`ssh_key_ids`), sem nenhuma outra mudança no Host. Se o plano criar, substituir ou destruir `hostinger_vps.host`, ou mudar outro atributo dele, pare e não aplique.
5. `tofu apply`, após revisar o plano.

Nas execuções seguintes, pule o passo 3; um `tofu plan` sem mudanças confirma que o Host continua como declarado. Nunca rode `tofu apply` com o state vazio: sem o import, o OpenTofu compraria um Host novo.

O R2 deve ser usado por apenas um operador de cada vez: esta configuração não implementa bloqueio distribuído. Não execute operações concorrentes sobre o mesmo state. Não salve planos ou state em arquivos compartilhados; o OpenTofu criptografa ambos, mas comandos de inspeção podem revelar seus conteúdos. Os arquivos locais de state, planos e variáveis, bem como `.terraform/`, são ignorados pelo Git. Ao terminar, remova as variáveis de credenciais do ambiente ou encerre o shell.

Para verificação sem credenciais nem criação de recursos: `tofu init -backend=false`, `tofu validate` e `tofu test`, que usam providers simulados. `tests/import_plan_test.sh` (requer `openssl` e `python3`) roda o provider real contra uma API falsa local, sem contatar a Hostinger. Ele importa um Host cujo plano e template diferem dos declarados e falha se o plano fizer algo além de anexar a chave SSH. Nenhum dos testes comprova acesso real aos serviços.

## Firewall da Hostinger e acesso de emergência

O provider oficial fixado na versão 0.1.23 não disponibiliza recursos de firewall. Configure o firewall da Hostinger manualmente no hPanel, em VPS → Host → Segurança → Firewall: crie e ative um grupo com regras de entrada TCP para as portas 80 e 443, com origem pública, e sem permissão pública para a porta 22. Confira as regras e a política aplicada para IPv4 e IPv6. O firewall da Hostinger é independente do firewall do sistema operacional; ambos precisam estar configurados. Consulte as [instruções da Hostinger](https://support.hostinger.com/en/articles/8172641-how-to-use-a-managed-vps-firewall).

Antes de bloquear o SSH público, confirme uma sessão SSH funcional pela tailnet e teste o acesso de emergência. No hPanel, abra VPS, selecione o Host e clique em **Browser terminal**. O terminal apresenta um login local: mantenha uma credencial de console válida, guardada com segurança, e teste-a antes de depender dela. Este acesso de emergência é distinto do login SSH por chave; não habilite autenticação por senha no SSH para usá-lo. Consulte a [documentação do Browser Terminal](https://support.hostinger.com/en/articles/7978544-how-to-use-the-browser-terminal).

Após aplicar as regras, teste de uma rede externa que a porta 22 não responde nos endereços públicos IPv4 e IPv6 e, de um dispositivo autorizado na tailnet, que o SSH funciona pelo endereço Tailscale. Essas verificações e o teste do terminal web exigem um Host real.

## Backups no R2

O OpenTofu mantém `dangus-backups`, três locks e três regras de lifecycle no state criptografado. Objetos em `daily/`, `weekly/` e `monthly/` ficam protegidos por 7, 28 e 90 dias, respectivamente; o lifecycle os apaga após esses prazos. O token do Host permite leitura e escrita de objetos somente nesse bucket, sem administração de buckets. O state contém o token e as saídas sensíveis derivadas dele; não compartilhe seu conteúdo.

Depois de revisar e aplicar o plano autorizado acima, no mesmo shell, copie as credenciais S3 para o projeto `ops`:

```bash
../backup/copy-r2-credentials.sh
```

O script cria `ops__R2_BACKUP_ACCESS_KEY_ID` e `ops__R2_BACKUP_SECRET_ACCESS_KEY` ou confirma valores existentes iguais; valores diferentes causam erro. As credenciais são lidas das saídas sensíveis do state e não são exibidas. O comando `bws` recebe valores nos argumentos de processo; execute em máquina confiável sem outros usuários locais.

Instale o `age-keygen` oficial versão 1.2.1 conforme [instruções de instalação do age](https://github.com/FiloSottile/age/tree/v1.2.1#installation). Com `OPS_PROJECT_ID` e acesso ao BWS configurados, gere a chave uma única vez:

```bash
../backup/generate-age-key.sh
git add ../backup/age.pub
```

A chave privada é criada no BWS como `ops__BACKUP_AGE_PRIVATE_KEY`, fora do state; a chave pública fica em `infra/backup/age.pub` e deve ser commitada para o Host. O arquivo ainda não existe: gere-o durante o rollout. O script recusa sobrescrever qualquer uma das duas chaves. Se a escrita do arquivo público falhar após criar o secret, recupere a chave pública da identidade no BWS em vez de gerar outra. A chave privada também passa como argumento ao processo `bws`.

Verificações locais: `tofu validate`, `tofu test` (providers simulados) e `../backup/tests/scripts.sh` (BWS simulado). Após o apply, envie um objeto de teste a cada prefixo com a credencial do Host e confirme que a tentativa de apagá-lo dentro do prazo falha. Essa verificação exige recursos e credenciais reais e não é substituída pelos testes simulados.

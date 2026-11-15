# Provisionamento do Host

Esta configuração cria um Host Hostinger KVM 4 no Brasil e registra sua chave pública SSH. O state usa o bucket R2 dedicado `dangus-tofu-state`, com criptografia AES-GCM nativa do OpenTofu. O provider Cloudflare está disponível para os buckets e DNS de trabalhos futuros.

## Pré-requisitos

- OpenTofu 1.10 ou posterior (menor que 2.0), `bws` e `jq`.
- Conta Hostinger com método de pagamento padrão e acesso à API. Confirme preço e disponibilidade do plano mensal KVM 4 antes de aplicar.
- Bucket R2 privado `dangus-tofu-state` já criado na conta Cloudflare, antes de `tofu init`: um backend não pode criar seu próprio bucket. As credenciais R2 precisam permitir leitura, escrita e listagem desse bucket. A criação do bucket é uma etapa separada, sujeita a autorização.
- Acesso ao projeto `ops` do BWS com `BWS_ACCESS_TOKEN`. Crie nele o secret `platform__TOFU_STATE_PASSPHRASE` com uma frase aleatória forte de pelo menos 16 caracteres e preserve-a: perdê-la impede a leitura do state. Não troque a frase sem seguir o procedimento de rotação de chaves do OpenTofu.
- Os secrets existentes no projeto `ops`: `platform__HOSTINGER_API_TOKEN`, `platform__CLOUDFLARE_ACCOUNT_ID`, `platform__CLOUDFLARE_ZONE_ID`, `platform__CLOUDFLARE_DNS_TOKEN`, `platform__CLOUDFLARE_R2_TOKEN`, `platform__R2_ACCESS_KEY_ID`, `platform__R2_SECRET_ACCESS_KEY` e `platform__R2_ENDPOINT`. O token Cloudflare usado pelo provider deve ter as permissões necessárias à operação futura; o token DNS é usado no exemplo abaixo. Os IDs e o token R2 da API Cloudflare são reservados para quando os respectivos recursos forem definidos; as credenciais S3 do backend são distintas.

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
export CLOUDFLARE_API_TOKEN="$(secret platform__CLOUDFLARE_DNS_TOKEN)"
export AWS_ACCESS_KEY_ID="$(secret platform__R2_ACCESS_KEY_ID)"
export AWS_SECRET_ACCESS_KEY="$(secret platform__R2_SECRET_ACCESS_KEY)"
export AWS_ENDPOINT_URL_S3="$(secret platform__R2_ENDPOINT)"
export TF_VAR_state_passphrase="$(secret platform__TOFU_STATE_PASSPHRASE)"
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
```

Confira que todos os valores foram carregados sem imprimi-los. Consulte o catálogo da API Hostinger para selecionar o ID do datacenter no Brasil e o ID de um template de sistema operacional disponível. Informe também o caminho da chave pública SSH; não use a chave privada. O plano é `hostingercom-vps-kvm4-usd-1m` e a configuração recusa um datacenter que o catálogo não identifica como brasileiro.

```bash
export TF_VAR_data_center_id="<id-do-datacenter-no-brasil>"
export TF_VAR_template_id="<id-do-template>"
export TF_VAR_ssh_public_key="$(cat ~/.ssh/id_ed25519.pub)"
tofu init
tofu plan
# Após revisar o plano e obter autorização para o custo:
tofu apply
```

O R2 deve ser usado por apenas um operador de cada vez: esta configuração não implementa bloqueio distribuído. Não execute operações concorrentes sobre o mesmo state. Não salve planos ou state em arquivos compartilhados; o OpenTofu criptografa ambos, mas comandos de inspeção podem revelar seus conteúdos. Os arquivos locais de state, planos e variáveis, bem como `.terraform/`, são ignorados pelo Git. Ao terminar, remova as variáveis de credenciais do ambiente ou encerre o shell.

Para verificação sem credenciais nem criação de recursos: `tofu init -backend=false`, `tofu validate` e `tofu test`. Os testes usam providers simulados e não comprovam disponibilidade, cobrança nem acesso real aos serviços.

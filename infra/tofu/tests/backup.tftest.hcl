mock_provider "hostinger" {
  mock_resource "hostinger_vps_ssh_key" { defaults = { id = "123" } }
  mock_data "hostinger_vps_data_centers" {
    defaults = { data_centers = [{ id = 42, name = "Brasil", location = "Brazil", city = "São Paulo", continent = "South America" }] }
  }
}
mock_provider "cloudflare" {}
variables {
  state_passphrase      = "frase-de-teste-sem-segredo"
  cloudflare_account_id = "conta-teste"
  data_center_id        = 42
  template_id           = 1002
  ssh_public_key        = "ssh-ed25519 exemplo"
  telegram_bot_token    = "token-teste"
  telegram_chat_id      = "chat-teste"
}
run "backup" {
  command = plan
  assert {
    condition     = cloudflare_r2_bucket.backups.name == "dangus-backups" && length(cloudflare_r2_bucket_lock.backups.rules) == 3 && alltrue([for rule in cloudflare_r2_bucket_lock.backups.rules : rule.enabled && rule.condition.type == "Age" && lookup({ "daily/" = 604800, "weekly/" = 2419200, "monthly/" = 7776000 }, rule.prefix, -1) == rule.condition.max_age_seconds])
    error_message = "Os locks devem proteger cada prefixo pelo prazo previsto."
  }
  assert {
    condition     = toset([for rule in cloudflare_r2_bucket_lock.backups.rules : rule.prefix]) == toset(["daily/", "weekly/", "monthly/"]) && toset([for rule in cloudflare_r2_bucket_lifecycle.backups.rules : rule.conditions.prefix]) == toset(["daily/", "weekly/", "monthly/"])
    error_message = "Locks e lifecycle devem cobrir cada prefixo exatamente uma vez."
  }
  assert {
    condition     = length(cloudflare_r2_bucket_lifecycle.backups.rules) == 3 && alltrue([for rule in cloudflare_r2_bucket_lifecycle.backups.rules : rule.enabled && rule.delete_objects_transition.condition.type == "Age" && lookup({ "daily/" = 604800, "weekly/" = 2419200, "monthly/" = 7776000 }, rule.conditions.prefix, -1) == rule.delete_objects_transition.condition.max_age])
    error_message = "O lifecycle deve excluir cada prefixo após o prazo previsto."
  }
  assert {
    condition     = length(cloudflare_api_token.backup_host.policies) == 1 && cloudflare_api_token.backup_host.policies[0].effect == "allow" && cloudflare_api_token.backup_host.policies[0].permission_groups[0].id == "2efd5506f9c8494dacb1fa10a3e7d5b6" && length(cloudflare_api_token.backup_host.policies[0].permission_groups) == 1 && jsondecode(cloudflare_api_token.backup_host.policies[0].resources) == { "com.cloudflare.edge.r2.bucket.conta-teste_default_dangus-backups" = "*" }
    error_message = "O token deve permitir somente objetos do bucket de Backups."
  }
}

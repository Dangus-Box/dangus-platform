mock_provider "hostinger" {
  mock_data "hostinger_vps_data_centers" {
    defaults = { data_centers = [{ id = 42, name = "Brasil", location = "Brazil", city = "São Paulo", continent = "South America" }] }
  }
}
mock_provider "cloudflare" {
  mock_data "cloudflare_account_api_token_permission_groups_list" {
    defaults = { result = [{ id = "2efd5506f9c8494dacb1fa10a3e7d5b6", name = "Workers R2 Storage Bucket Item Write", scopes = ["com.cloudflare.edge.r2.bucket"], is_selectable = true, category = "developer_platform" }] }
  }
}
variables {
  state_passphrase      = "test-passphrase-not-secret"
  cloudflare_account_id = "conta-teste"
  data_center_id        = 42
  template_id           = 1002
  telegram_bot_token    = "token-teste"
  telegram_chat_id      = "chat-teste"
}
run "backup" {
  command = plan
  assert {
    condition     = cloudflare_r2_bucket.backups.name == "dangus-backups" && length(cloudflare_r2_bucket_lock.backups.rules) == 3 && alltrue([for rule in cloudflare_r2_bucket_lock.backups.rules : rule.enabled && rule.condition.type == "Age" && lookup({ "daily/" = 604800, "weekly/" = 2419200, "monthly/" = 7776000 }, rule.prefix, -1) == rule.condition.max_age_seconds])
    error_message = "Locks must protect each prefix for the intended duration."
  }
  assert {
    condition     = toset([for rule in cloudflare_r2_bucket_lock.backups.rules : rule.prefix]) == toset(["daily/", "weekly/", "monthly/"]) && toset([for rule in cloudflare_r2_bucket_lifecycle.backups.rules : rule.conditions.prefix]) == toset(["daily/", "weekly/", "monthly/"])
    error_message = "Locks and lifecycle must cover each prefix exactly once."
  }
  assert {
    condition     = length(cloudflare_r2_bucket_lifecycle.backups.rules) == 3 && alltrue([for rule in cloudflare_r2_bucket_lifecycle.backups.rules : rule.enabled && rule.delete_objects_transition.condition.type == "Age" && lookup({ "daily/" = 604800, "weekly/" = 2419200, "monthly/" = 7776000 }, rule.conditions.prefix, -1) == rule.delete_objects_transition.condition.max_age])
    error_message = "Lifecycle must delete each prefix after the intended duration."
  }
  assert {
    condition     = cloudflare_account_token.backup_host.account_id == "conta-teste" && length(cloudflare_account_token.backup_host.policies) == 1 && cloudflare_account_token.backup_host.policies[0].effect == "allow" && cloudflare_account_token.backup_host.policies[0].permission_groups[0].id == "2efd5506f9c8494dacb1fa10a3e7d5b6" && length(cloudflare_account_token.backup_host.policies[0].permission_groups) == 1 && jsondecode(cloudflare_account_token.backup_host.policies[0].resources) == { "com.cloudflare.edge.r2.bucket.conta-teste_default_dangus-backups" = "*" }
    error_message = "The token must allow only objects in the Backup bucket."
  }
}

# The fixed ID must exist in the account and have R2 bucket scope; otherwise the plan fails.
run "permission_group_without_bucket_scope" {
  command = plan
  override_data {
    target = data.cloudflare_account_api_token_permission_groups_list.all
    values = { result = [{ id = "2efd5506f9c8494dacb1fa10a3e7d5b6", name = "Workers R2 Storage Bucket Item Write", scopes = ["com.cloudflare.api.account"], is_selectable = true, category = "developer_platform" }] }
  }
  expect_failures = [cloudflare_account_token.backup_host]
}

run "permission_group_missing" {
  command = plan
  override_data {
    target = data.cloudflare_account_api_token_permission_groups_list.all
    values = { result = [] }
  }
  expect_failures = [cloudflare_account_token.backup_host]
}

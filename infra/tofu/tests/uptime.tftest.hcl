mock_provider "hostinger" {
  mock_data "hostinger_vps_data_centers" {
    defaults = { data_centers = [{ id = 42, name = "Brasil", location = "Brazil", city = "São Paulo", continent = "South America" }] }
  }
}
mock_provider "cloudflare" {
  mock_data "cloudflare_account_api_token_permission_groups_list" {
    defaults = { result = [{ id = "2efd5506f9c8494dacb1fa10a3e7d5b6", name = "Workers R2 Storage Bucket Item Write", scopes = ["com.cloudflare.edge.r2.bucket"], is_selectable = true, category = "developer_platform" }] }
  }
  mock_resource "cloudflare_workers_kv_namespace" { defaults = { id = "test-namespace" } }
}
variables {
  state_passphrase      = "test-passphrase-not-secret"
  cloudflare_account_id = "test-account"
  data_center_id        = 42
  template_id           = 1002
  telegram_bot_token    = "test-token"
  telegram_chat_id      = "test-chat"
}
run "uptime" {
  command = plan
  assert {
    condition     = cloudflare_workers_cron_trigger.uptime.schedules[0].cron == "* * * * *" && length(cloudflare_workers_cron_trigger.uptime.schedules) == 1
    error_message = "The Worker must run every minute."
  }
  assert {
    condition     = cloudflare_workers_kv_namespace.uptime.title == "dangus-uptime" && cloudflare_workers_script.uptime.bindings[0].type == "kv_namespace" && cloudflare_workers_script.uptime.bindings[0].name == "UPTIME_KV" && cloudflare_workers_script.uptime.bindings[0].namespace_id == cloudflare_workers_kv_namespace.uptime.id
    error_message = "The Worker must receive the KV namespace."
  }
  assert {
    condition     = nonsensitive(cloudflare_workers_script.uptime.bindings[1].name == "TELEGRAM_BOT_TOKEN" && cloudflare_workers_script.uptime.bindings[1].type == "secret_text" && cloudflare_workers_script.uptime.bindings[1].text == var.telegram_bot_token && cloudflare_workers_script.uptime.bindings[2].name == "TELEGRAM_CHAT_ID" && cloudflare_workers_script.uptime.bindings[2].type == "secret_text" && cloudflare_workers_script.uptime.bindings[2].text == var.telegram_chat_id)
    error_message = "The Worker must receive the Telegram secrets."
  }
}

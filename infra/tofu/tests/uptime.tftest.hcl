mock_provider "hostinger" {
  mock_resource "hostinger_vps_ssh_key" { defaults = { id = "123" } }
  mock_data "hostinger_vps_data_centers" {
    defaults = { data_centers = [{ id = 42, name = "Brasil", location = "Brazil", city = "São Paulo", continent = "South America" }] }
  }
}
mock_provider "cloudflare" {
  mock_resource "cloudflare_workers_kv_namespace" { defaults = { id = "namespace-teste" } }
}
variables {
  state_passphrase      = "frase-de-teste-sem-segredo"
  cloudflare_account_id = "conta-teste"
  data_center_id        = 42
  template_id           = 1002
  ssh_public_key        = "ssh-ed25519 exemplo"
  telegram_bot_token    = "token-teste"
  telegram_chat_id      = "chat-teste"
}
run "uptime" {
  command = plan
  assert {
    condition     = cloudflare_workers_cron_trigger.uptime.schedules[0].cron == "* * * * *" && length(cloudflare_workers_cron_trigger.uptime.schedules) == 1
    error_message = "O Worker deve executar a cada minuto."
  }
  assert {
    condition     = cloudflare_workers_kv_namespace.uptime.title == "dangus-uptime" && cloudflare_workers_script.uptime.bindings[0].type == "kv_namespace" && cloudflare_workers_script.uptime.bindings[0].name == "UPTIME_KV" && cloudflare_workers_script.uptime.bindings[0].namespace_id == cloudflare_workers_kv_namespace.uptime.id
    error_message = "O Worker deve receber o namespace KV."
  }
  assert {
    condition     = nonsensitive(cloudflare_workers_script.uptime.bindings[1].name == "TELEGRAM_BOT_TOKEN" && cloudflare_workers_script.uptime.bindings[1].type == "secret_text" && cloudflare_workers_script.uptime.bindings[1].text == var.telegram_bot_token && cloudflare_workers_script.uptime.bindings[2].name == "TELEGRAM_CHAT_ID" && cloudflare_workers_script.uptime.bindings[2].type == "secret_text" && cloudflare_workers_script.uptime.bindings[2].text == var.telegram_chat_id)
    error_message = "O Worker deve receber os secrets do Telegram."
  }
}

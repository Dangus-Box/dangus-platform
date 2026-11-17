variable "telegram_bot_token" {
  type      = string
  sensitive = true
}

variable "telegram_chat_id" {
  type      = string
  sensitive = true
}

resource "cloudflare_workers_kv_namespace" "uptime" {
  account_id = var.cloudflare_account_id
  title      = "dangus-uptime"
}

resource "cloudflare_workers_script" "uptime" {
  account_id         = var.cloudflare_account_id
  script_name        = "dangus-uptime"
  content            = file("${path.module}/../uptime/worker.js")
  main_module        = "worker.js"
  compatibility_date = "2026-01-01"
  bindings = [
    { name = "UPTIME_KV", type = "kv_namespace", namespace_id = cloudflare_workers_kv_namespace.uptime.id },
    { name = "TELEGRAM_BOT_TOKEN", type = "secret_text", text = var.telegram_bot_token },
    { name = "TELEGRAM_CHAT_ID", type = "secret_text", text = var.telegram_chat_id },
  ]
}

resource "cloudflare_workers_cron_trigger" "uptime" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_workers_script.uptime.script_name
  schedules   = [{ cron = "* * * * *" }]
}

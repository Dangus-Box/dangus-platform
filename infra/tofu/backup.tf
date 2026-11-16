variable "cloudflare_account_id" {
  description = "ID da conta Cloudflare que contém o bucket de Backups."
  type        = string
}

locals {
  backup_retention = { daily = 7, weekly = 28, monthly = 90 }
}

resource "cloudflare_r2_bucket" "backups" {
  account_id = var.cloudflare_account_id
  name       = "dangus-backups"
}

resource "cloudflare_r2_bucket_lock" "backups" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.backups.name
  rules = [for prefix, days in local.backup_retention : {
    id        = prefix
    prefix    = "${prefix}/"
    enabled   = true
    condition = { type = "Age", max_age_seconds = days * 86400 }
  }]
}

resource "cloudflare_r2_bucket_lifecycle" "backups" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.backups.name
  rules = [for prefix, days in local.backup_retention : {
    id                        = prefix
    enabled                   = true
    conditions                = { prefix = "${prefix}/" }
    delete_objects_transition = { condition = { type = "Age", max_age = days * 86400 } }
  }]
}

resource "cloudflare_api_token" "backup_host" {
  name = "dangus-backup-host"
  policies = [{
    effect            = "allow"
    permission_groups = [{ id = "2efd5506f9c8494dacb1fa10a3e7d5b6" }]
    resources         = jsonencode({ "com.cloudflare.edge.r2.bucket.${var.cloudflare_account_id}_default_${cloudflare_r2_bucket.backups.name}" = "*" })
  }]
}

output "r2_backup_access_key_id" {
  value     = cloudflare_api_token.backup_host.id
  sensitive = true
}

output "r2_backup_secret_access_key" {
  value     = sha256(cloudflare_api_token.backup_host.value)
  sensitive = true
}

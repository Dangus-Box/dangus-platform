variable "cloudflare_account_id" {
  description = "Cloudflare account ID containing the Backup bucket."
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

# "Workers R2 Storage Bucket Item Write". Cloudflare recommends referencing
# permission groups by ID: the name is cosmetic and may change. The ID is fixed and
# the account list confirms it exists and has R2 bucket scope.
locals {
  r2_bucket_item_write = "2efd5506f9c8494dacb1fa10a3e7d5b6"
}

data "cloudflare_account_api_token_permission_groups_list" "all" {
  account_id = var.cloudflare_account_id
}

resource "cloudflare_account_token" "backup_host" {
  account_id = var.cloudflare_account_id
  name       = "dangus-backup-host"
  policies = [{
    effect            = "allow"
    permission_groups = [{ id = local.r2_bucket_item_write }]
    resources         = jsonencode({ "com.cloudflare.edge.r2.bucket.${var.cloudflare_account_id}_default_${cloudflare_r2_bucket.backups.name}" = "*" })
  }]

  lifecycle {
    precondition {
      condition = anytrue([
        for group in data.cloudflare_account_api_token_permission_groups_list.all.result :
        group.id == local.r2_bucket_item_write && contains(group.scopes, "com.cloudflare.edge.r2.bucket")
      ])
      error_message = "Permission group ${local.r2_bucket_item_write} (Workers R2 Storage Bucket Item Write) does not exist in the account or lacks R2 bucket scope."
    }
  }
}

output "r2_backup_access_key_id" {
  value     = cloudflare_account_token.backup_host.id
  sensitive = true
}

output "r2_backup_secret_access_key" {
  value     = sha256(cloudflare_account_token.backup_host.value)
  sensitive = true
}

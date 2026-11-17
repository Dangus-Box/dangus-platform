terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  required_providers {
    hostinger = {
      source  = "hostinger/hostinger"
      version = "0.1.23"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.29.0"
    }
  }

  backend "s3" {
    bucket                      = "dangus-tofu-state"
    key                         = "host/terraform.tfstate"
    region                      = "auto"
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }

  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }
    state {
      method   = method.aes_gcm.state
      enforced = true
    }
    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

provider "hostinger" {}
provider "cloudflare" {}

data "hostinger_vps_data_centers" "available" {}

# The SSH key created by the partial apply is removed from state without deletion from
# Hostinger; SSH access comes from bootstrap.
removed {
  from = hostinger_vps_ssh_key.host
  lifecycle {
    destroy = false
  }
}

# The Host already exists and enters state via `tofu import` (see README).
resource "hostinger_vps" "host" {
  plan           = "hostingercom-vps-kvm4-usd-1m"
  data_center_id = var.data_center_id
  template_id    = var.template_id

  lifecycle {
    # Destroying cancels the Host subscription.
    prevent_destroy = true
    # Changing the plan, datacenter or password forces Host recreation, and changing the
    # template (or associated post-install script) reinstalls the system.
    # ssh_key_ids: the partial apply left the value in state; removing it would call
    # a nonexistent Hostinger route (404). SSH access comes from bootstrap.
    ignore_changes = [plan, data_center_id, password, template_id, post_install_script_id, ssh_key_ids]

    precondition {
      condition = anytrue([
        for dc in data.hostinger_vps_data_centers.available.data_centers :
        dc.id == var.data_center_id && (lower(dc.location) == "brazil" || lower(dc.location) == "brasil" || lower(dc.location) == "br")
      ])
      error_message = "The selected datacenter must be in Brazil."
    }
  }
}

output "host_ipv4" {
  value = hostinger_vps.host.ipv4_address
}

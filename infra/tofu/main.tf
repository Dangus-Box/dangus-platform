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

# A chave SSH criada pelo apply parcial sai do state sem ser excluída na
# Hostinger; o acesso SSH vem do bootstrap.
removed {
  from = hostinger_vps_ssh_key.host
  lifecycle {
    destroy = false
  }
}

# O Host já existe e entra no state por `tofu import` (ver README).
resource "hostinger_vps" "host" {
  plan           = "hostingercom-vps-kvm4-usd-1m"
  data_center_id = var.data_center_id
  template_id    = var.template_id

  lifecycle {
    # Destruir cancela a assinatura do Host.
    prevent_destroy = true
    # Mudar plano, datacenter ou senha força a recriação do Host, e mudar o
    # template (ou o script de pós-instalação usado junto) reinstala o sistema.
    # ssh_key_ids: o apply parcial deixou o valor no state; removê-lo chamaria
    # uma rota inexistente da Hostinger (404). O acesso SSH vem do bootstrap.
    ignore_changes = [plan, data_center_id, password, template_id, post_install_script_id, ssh_key_ids]

    precondition {
      condition = anytrue([
        for dc in data.hostinger_vps_data_centers.available.data_centers :
        dc.id == var.data_center_id && (lower(dc.location) == "brazil" || lower(dc.location) == "brasil" || lower(dc.location) == "br")
      ])
      error_message = "O datacenter selecionado deve estar no Brasil."
    }
  }
}

output "host_ipv4" {
  value = hostinger_vps.host.ipv4_address
}

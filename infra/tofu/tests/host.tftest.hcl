mock_provider "hostinger" {
  mock_resource "hostinger_vps_ssh_key" {
    defaults = { id = "123" }
  }
  mock_data "hostinger_vps_data_centers" {
    defaults = {
      data_centers = [{ id = 42, name = "Brasil", location = "Brazil", city = "São Paulo", continent = "South America" }]
    }
  }
}
mock_provider "cloudflare" {}

variables {
  state_passphrase = "frase-de-teste-sem-segredo"
  data_center_id   = 42
  template_id      = 1002
  ssh_public_key   = "ssh-ed25519 exemplo"
}

run "host_no_brasil" {
  command = plan

  assert {
    condition     = hostinger_vps.host.plan == "hostingercom-vps-kvm4-usd-1m" && hostinger_vps.host.data_center_id == 42 && length(hostinger_vps.host.ssh_key_ids) == 1
    error_message = "O Host deve usar KVM 4, o datacenter selecionado e uma chave SSH."
  }
}

run "rejeita_datacenter_fora_do_brasil" {
  command = plan

  variables {
    data_center_id = 99
  }

  expect_failures = [hostinger_vps.host]
}

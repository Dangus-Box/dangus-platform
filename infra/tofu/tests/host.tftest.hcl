mock_provider "hostinger" {
  mock_data "hostinger_vps_data_centers" {
    defaults = {
      data_centers = [{ id = 42, name = "Brasil", location = "Brazil", city = "São Paulo", continent = "South America" }]
    }
  }
}
mock_provider "cloudflare" {
  mock_data "cloudflare_account_api_token_permission_groups_list" {
    defaults = { result = [{ id = "2efd5506f9c8494dacb1fa10a3e7d5b6", name = "Workers R2 Storage Bucket Item Write", scopes = ["com.cloudflare.edge.r2.bucket"], is_selectable = true, category = "developer_platform" }] }
  }
}

variables {
  cloudflare_account_id = "test-account"
  state_passphrase      = "test-passphrase-not-secret"
  data_center_id        = 42
  template_id           = 1002
  telegram_bot_token    = "test-token"
  telegram_chat_id      = "test-chat"
}

run "host_in_brazil" {
  command = plan

  assert {
    condition     = hostinger_vps.host.plan == "hostingercom-vps-kvm4-usd-1m" && hostinger_vps.host.data_center_id == 42
    error_message = "The Host must use KVM 4 and the selected datacenter."
  }
}

run "rejects_datacenter_outside_brazil" {
  command = plan

  variables {
    data_center_id = 99
  }

  expect_failures = [hostinger_vps.host]
}

run "accepts_api_country_code" {
  command = plan

  override_data {
    target = data.hostinger_vps_data_centers.available
    values = {
      data_centers = [{ id = 42, name = "bnu", location = "br", city = "São Paulo", continent = "South America" }]
    }
  }
}

run "rejects_existing_datacenter_outside_brazil" {
  command = plan

  override_data {
    target = data.hostinger_vps_data_centers.available
    values = {
      data_centers = [{ id = 42, name = "phx", location = "us", city = "Phoenix", continent = "North America" }]
    }
  }

  expect_failures = [hostinger_vps.host]
}

# Synthetic demo preview on Container Apps. The app only accepts a loopback
# database and Host/Origin, so one single-replica app runs three containers
# that share localhost: PostgreSQL (ephemeral, invented data only), the app in
# demo mode, and an nginx front that maps the public origin to loopback.

variable "app_image_tag" {
  description = "Image tag used only when the Container App is first created. Afterwards the deploy-azure workflow owns the app and proxy images."
  type        = string
  default     = "0b0ee74-202610171227"
}

resource "random_password" "postgres" {
  length  = 32
  special = false
}

locals {
  acr            = data.terraform_remote_state.platform.outputs.acr_login_server
  app_name       = "ca-deepnative-dev"
  public_host    = "${local.app_name}.${azurerm_container_app_environment.app.default_domain}"
  postgres_image = "${local.acr}/library/postgres:18-alpine"
}

# The app identity also deploys from GitHub Actions (OIDC, main branch): it
# pushes images to the platform ACR and updates this Container App, which its
# resource-group Contributor role from app-onboard already allows.
resource "azurerm_role_assignment" "acr_push" {
  scope                = data.terraform_remote_state.platform.outputs.acr_resource_id
  role_definition_name = "AcrPush"
  principal_id         = module.onboard.identity_principal_id
  principal_type       = "ServicePrincipal"
}

resource "azurerm_container_app_environment" "app" {
  name                       = "cae-deepnative-dev"
  location                   = module.onboard.location
  resource_group_name        = module.onboard.resource_group_name
  log_analytics_workspace_id = data.terraform_remote_state.platform.outputs.log_analytics_workspace_id
  tags                       = module.onboard.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

resource "azurerm_container_app" "app" {
  name                         = local.app_name
  container_app_environment_id = azurerm_container_app_environment.app.id
  resource_group_name          = module.onboard.resource_group_name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = module.onboard.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [module.onboard.identity_id]
  }

  registry {
    server   = local.acr
    identity = module.onboard.identity_id
  }

  secret {
    name  = "postgres-password"
    value = random_password.postgres.result
  }

  secret {
    name  = "database-url"
    value = "postgresql://dne:${random_password.postgres.result}@127.0.0.1:5432/dne_demo"
  }

  ingress {
    external_enabled = true
    target_port      = 8080
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    # The database lives in the replica, so there must be exactly one.
    min_replicas = 1
    max_replicas = 1

    container {
      name   = "postgres"
      image  = local.postgres_image
      cpu    = 0.25
      memory = "0.5Gi"
      args   = ["-c", "listen_addresses=127.0.0.1"]

      env {
        name  = "POSTGRES_USER"
        value = "dne"
      }
      env {
        name  = "POSTGRES_DB"
        value = "dne_demo"
      }
      env {
        name        = "POSTGRES_PASSWORD"
        secret_name = "postgres-password"
      }
    }

    container {
      name   = "app"
      image  = "${local.acr}/deepnative/app:${var.app_image_tag}"
      cpu    = 0.5
      memory = "1Gi"

      env {
        name        = "DNE_DATABASE_URL"
        secret_name = "database-url"
      }
      env {
        name  = "DNE_APP_MODE"
        value = "demo"
      }
      env {
        name  = "DNE_DEMO_IMPERSONATION"
        value = "false"
      }
    }

    container {
      name   = "proxy"
      image  = "${local.acr}/deepnative/proxy:${var.app_image_tag}"
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "PUBLIC_HOST"
        value = local.public_host
      }
    }
  }

  lifecycle {
    # .github/workflows/deploy-azure.yml rolls these to the verified main SHA.
    ignore_changes = [
      template[0].container[1].image,
      template[0].container[2].image,
    ]
  }
}

output "app_url" {
  value = "https://${azurerm_container_app.app.ingress[0].fqdn}"
}

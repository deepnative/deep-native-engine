# Durable hosted application. Existing template is guarded during initial
# preservation: infrastructure provisioning alone does not roll the app.
# The reviewed deploy workflow owns the compatible complete template after
# the final frozen snapshot has been restored and verified.

variable "app_image_tag" {
  description = "Image tag used only when the Container App is first created. Afterwards the deploy-azure workflow owns the app and proxy images."
  type        = string
  default     = "0b0ee74-202610171227"
}

# Retain the original legacy credential in state until preservation/cutover is
# complete. It is never used by the new identity-authenticated database.
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
    # One warm application replica; PostgreSQL and private files are external.
    min_replicas = 1
    max_replicas = 1

    container {
      name   = "app"
      image  = "${local.acr}/deepnative/app:${var.app_image_tag}"
      cpu    = 0.5
      memory = "1Gi"
      dynamic "env" {
        for_each = {
          DNE_DATABASE_URL                     = "postgresql://${local.database_role}@${azurerm_postgresql_flexible_server.durable.fqdn}/${local.durable_database}?sslmode=verify-full"
          DNE_DATABASE_AUTH                    = "managed-identity"
          DNE_PUBLIC_ORIGIN                    = "https://engine.deepnative.io"
          DNE_AZURE_BLOB_ACCOUNT_URL           = trimsuffix(azurerm_storage_account.evidence.primary_blob_endpoint, "/")
          DNE_AZURE_BLOB_CONTAINER             = azurerm_storage_container.evidence.name
          DNE_AZURE_MANAGED_IDENTITY_CLIENT_ID = module.onboard.identity_client_id
          DNE_APP_MODE                         = "demo"
          DNE_DEMO_IMPERSONATION               = "false"
          DNE_LOCAL_STAFF_ENTRY                = "enabled"
          DNE_PREPARED_REVIEW_SAMPLES          = "enabled"
          DNE_SAMPLE_ASSIGNMENT_ADMINISTRATION = "enabled"
          DNE_REVIEW_TIME_WRITES               = "enabled"
          DNE_REVIEW_TIME_GRANT_ADMINISTRATION = "enabled"
          DNE_CIRCLE_DISCUSSION                = "enabled"
          DNE_LOCAL_CIRCLE_ADMIN               = "enabled"
          DNE_EVENT_REGISTRATION               = "enabled"
          DNE_LOCAL_EVENT_ADMIN                = "enabled"
          DNE_LOCAL_EVENT_SCHEDULING           = "enabled"
          DNE_WORKFLOW_REVIEW_REQUESTS         = "enabled"
          DNE_LOCAL_SUPPORT_ASSIGNMENT         = "enabled"
        }
        content {
          name  = env.key
          value = env.value
        }
      }
    }
    container {
      name   = "proxy"
      image  = "${local.acr}/deepnative/proxy:${var.app_image_tag}"
      cpu    = 0.25
      memory = "0.5Gi"
      env {
        name  = "PUBLIC_HOST"
        value = "engine.deepnative.io"
      }
      env {
        name  = "LEGACY_HOST"
        value = local.public_host
      }
      readiness_probe {
        transport               = "HTTP"
        port                    = 8080
        path                    = "/"
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 3
        initial_delay           = 5
        header {
          name  = "Host"
          value = "engine.deepnative.io"
        }
      }
      startup_probe {
        transport               = "HTTP"
        port                    = 8080
        path                    = "/"
        interval_seconds        = 5
        timeout                 = 3
        failure_count_threshold = 60
        initial_delay           = 5
        header {
          name  = "Host"
          value = "engine.deepnative.io"
        }
      }
      liveness_probe {
        transport               = "TCP"
        port                    = 8080
        interval_seconds        = 10
        timeout                 = 3
        failure_count_threshold = 3
      }
    }
  }

  lifecycle {
    # The guarded deployment workflow owns the complete compatible image/config
    # template. Initial provisioning must NEVER restart the old ephemeral replica.
    # Preserve its secrets and the already-bound managed engine certificate too.
    ignore_changes  = [template, secret]
    prevent_destroy = true
  }
}

output "app_url" {
  value = "https://${azurerm_container_app.app.ingress[0].fqdn}"
}

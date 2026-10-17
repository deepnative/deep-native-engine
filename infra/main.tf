terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
  backend "azurerm" {
    resource_group_name  = "rg-alz-tfstate"
    storage_account_name = "sttfstate2c115b94b446"
    container_name       = "tfstate"
    key                  = "apps/deepnative-dev.tfstate"
    use_azuread_auth     = true
  }
}

provider "azurerm" {
  features {}
}

data "terraform_remote_state" "platform" {
  backend = "azurerm"
  config = {
    resource_group_name  = "rg-alz-tfstate"
    storage_account_name = "sttfstate2c115b94b446"
    container_name       = "tfstate"
    key                  = "platform.tfstate"
    use_azuread_auth     = true
  }
}

module "onboard" {
  source = "git::https://github.com/tomqwu/cloud_landing_zone_for_ai_coding.git//modules/app-onboard?ref=main"

  app_name         = "deepnative"
  env              = "dev"
  github_repo      = "deepnative/deep-native-engine"
  github_branches  = ["main"]
  owner_email      = "tom@deepnative.onmicrosoft.com"
  platform_outputs = data.terraform_remote_state.platform.outputs
}

output "resource_group_name" { value = module.onboard.resource_group_name }
output "azure_client_id" { value = module.onboard.identity_client_id }
output "azure_tenant_id" { value = module.onboard.tenant_id }
output "azure_subscription_id" { value = module.onboard.subscription_id }

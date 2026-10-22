terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
  backend "azurerm" {
    resource_group_name  = "rg-alz-tfstate"
    storage_account_name = "sttfstate2c115b94b446"
    container_name       = "tfstate"
    key                  = "apps/deepnative-dev.tfstate"
    use_azuread_auth     = true
    subscription_id      = "81e891a1-b374-4898-8fed-0871de418dae"
    tenant_id            = "72e3b797-967a-4279-ab8c-448b08fec738"
  }
}

provider "azurerm" {
  features {}
  subscription_id     = "81e891a1-b374-4898-8fed-0871de418dae"
  tenant_id           = "72e3b797-967a-4279-ab8c-448b08fec738"
  storage_use_azuread = true
}

data "terraform_remote_state" "platform" {
  backend = "azurerm"
  config = {
    resource_group_name  = "rg-alz-tfstate"
    storage_account_name = "sttfstate2c115b94b446"
    container_name       = "tfstate"
    subscription_id      = "81e891a1-b374-4898-8fed-0871de418dae"
    tenant_id            = "72e3b797-967a-4279-ab8c-448b08fec738"
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

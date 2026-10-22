# Durable technical hosting under the owner's 21 October deployment direction.
# Provision/restore these destinations BEFORE the guarded app-template cutover.
variable "app_egress_ipv4" {
  description = "Exact current Container App outbound IPv4 addresses, read immediately before plan. No all-Azure/world rule."
  type        = set(string)
  validation {
    condition     = length(var.app_egress_ipv4) > 0 && length(var.app_egress_ipv4) <= 200 && alltrue([for ip in var.app_egress_ipv4 : can(cidrhost("${ip}/32", 0)) && !contains(["0.0.0.0", "255.255.255.255"], ip)])
    error_message = "Supply a bounded set of exact IPv4 addresses, never a CIDR or all-Azure rule."
  }
}
variable "migration_ipv4" {
  description = "Optional exact migration operator IPv4, removed after the confirmed cutover."
  type        = string
  default     = null
  validation {
    condition     = var.migration_ipv4 == null ? true : can(cidrhost("${var.migration_ipv4}/32", 0)) && !contains(["0.0.0.0", "255.255.255.255"], var.migration_ipv4)
    error_message = "Migration access must be one exact IPv4 address."
  }
}
locals {
  durable_database = "deepnative"
  database_role    = "dne_engine"
  durable_egress   = setunion(var.app_egress_ipv4, var.migration_ipv4 == null ? toset([]) : toset([var.migration_ipv4]))
}
resource "azurerm_postgresql_flexible_server" "durable" {
  name                          = "pg-deepnative-dev-144x"
  resource_group_name           = module.onboard.resource_group_name
  location                      = module.onboard.location
  version                       = "18"
  sku_name                      = "B_Standard_B1ms"
  storage_mb                    = 32768
  public_network_access_enabled = true
  geo_redundant_backup_enabled  = false
  auto_grow_enabled             = false
  tags                          = module.onboard.tags
  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = false
    tenant_id                     = module.onboard.tenant_id
  }
  identity { type = "SystemAssigned" }
  lifecycle { prevent_destroy = true }
}
resource "azurerm_postgresql_flexible_server_active_directory_administrator" "migration" {
  server_name         = azurerm_postgresql_flexible_server.durable.name
  resource_group_name = module.onboard.resource_group_name
  tenant_id           = module.onboard.tenant_id
  object_id           = "2225a624-e3b8-47a2-afcf-614e9b4b66bf"
  principal_name      = "tom@deepnative.onmicrosoft.com"
  principal_type      = "User"
}
resource "azurerm_postgresql_flexible_server_database" "durable" {
  name      = local.durable_database
  server_id = azurerm_postgresql_flexible_server.durable.id
  charset   = "UTF8"
  collation = "en_US.utf8"
  lifecycle { prevent_destroy = true }
}
resource "azurerm_postgresql_flexible_server_firewall_rule" "app" {
  for_each         = local.durable_egress
  name             = "exact-${replace(each.value, ".", "-")}"
  server_id        = azurerm_postgresql_flexible_server.durable.id
  start_ip_address = each.value
  end_ip_address   = each.value
}
resource "azurerm_monitor_diagnostic_setting" "database" {
  name                       = "platform-metrics"
  target_resource_id         = azurerm_postgresql_flexible_server.durable.id
  log_analytics_workspace_id = module.onboard.log_analytics_workspace_id
  enabled_metric { category = "AllMetrics" }
}
resource "azurerm_storage_account" "evidence" {
  name                             = "stdeepnativedev144x"
  resource_group_name              = module.onboard.resource_group_name
  location                         = module.onboard.location
  account_tier                     = "Standard"
  account_replication_type         = "LRS"
  account_kind                     = "StorageV2"
  min_tls_version                  = "TLS1_2"
  https_traffic_only_enabled       = true
  allow_nested_items_to_be_public  = false
  shared_access_key_enabled        = false
  default_to_oauth_authentication  = true
  cross_tenant_replication_enabled = false
  local_user_enabled               = false
  tags                             = module.onboard.tags
  # Same-region Azure traffic cannot be filtered by the app's public egress
  # IPs. This is an HTTPS public endpoint with private Entra-only data access,
  # not a private endpoint. Never enable anonymous containers or shared keys.
  public_network_access_enabled = true

  identity { type = "SystemAssigned" }
  lifecycle { prevent_destroy = true }
}
resource "azurerm_storage_container" "evidence" {
  name                  = "private-evidence"
  storage_account_id    = azurerm_storage_account.evidence.id
  container_access_type = "private"
  lifecycle { prevent_destroy = true }
}
resource "azurerm_role_assignment" "evidence_writer" {
  scope                = azurerm_storage_container.evidence.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = module.onboard.identity_principal_id
  principal_type       = "ServicePrincipal"
}
resource "azurerm_monitor_diagnostic_setting" "evidence" {
  name                       = "platform-metrics"
  target_resource_id         = "${azurerm_storage_account.evidence.id}/blobServices/default"
  log_analytics_workspace_id = module.onboard.log_analytics_workspace_id
  enabled_metric { category = "Transaction" }
}
output "durable_database_host" { value = azurerm_postgresql_flexible_server.durable.fqdn }
output "durable_database_name" { value = local.durable_database }
output "durable_database_role" { value = local.database_role }
output "private_blob_account_url" { value = trimsuffix(azurerm_storage_account.evidence.primary_blob_endpoint, "/") }
output "private_blob_container" { value = azurerm_storage_container.evidence.name }

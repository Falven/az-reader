/// Stack: 20-workload
/// Purpose: Deploy az-reader Container App using shared modules and bootstrap state

locals {
  workload_code     = lower(var.workload_name)
  env_code          = lower(var.environment_code)
  identifier        = var.identifier != "" ? lower(var.identifier) : ""
  crawl_identifier  = local.identifier != "" ? "${local.identifier}-crawl" : "crawl"
  search_identifier = local.identifier != "" ? "${local.identifier}-search" : "search"
  cosmos_location   = var.cosmos_location != "" ? var.cosmos_location : var.location

  common_tags = merge({
    project     = local.workload_code
    environment = local.env_code
    location    = var.location
    managed_by  = "terraform"
  }, var.tags)
}

data "terraform_remote_state" "bootstrap" {
  backend = "azurerm"
  config = {
    use_azuread_auth     = true
    tenant_id            = var.tenant_id
    resource_group_name  = var.state_resource_group_name
    storage_account_name = var.state_storage_account_name
    container_name       = var.state_container_name
    key                  = var.state_blob_key
  }
}

module "env" {
  source = "../../modules/aca/environment"

  environment_code           = var.environment_code
  location                   = var.location
  workload_name              = var.workload_name
  identifier                 = var.identifier
  log_analytics_workspace_id = var.log_analytics_workspace_id
  log_retention_days         = var.log_retention_days
  tags                       = local.common_tags
}

module "cosmos" {
  source = "../../modules/data/cosmos"

  resource_group_name       = module.env.rg_name
  location                  = local.cosmos_location
  environment_code          = var.environment_code
  workload_name             = var.workload_name
  identifier                = var.identifier
  database_name             = "reader"
  rate_limit_container_name = "rateLimits"
  tags = merge(
    local.common_tags,
    { location = local.cosmos_location }
  )
}

locals {
  cosmos_app_settings = {
    COSMOS_ENABLED       = "true"
    COSMOS_ENDPOINT      = module.cosmos.endpoint
    COSMOS_DB            = module.cosmos.database_name
    RATE_LIMIT_CONTAINER = module.cosmos.rate_limit_container_name
  }

  cosmos_secrets = {
    "cosmos-key" = module.cosmos.primary_key
  }

  key_vault_rg        = var.key_vault_resource_group != "" ? var.key_vault_resource_group : module.env.rg_name
  _kv_name_validation = var.create_key_vault && var.key_vault_name == "" ? error("key_vault_name is required when create_key_vault is true") : true

  self_host_app_settings = {
    SELF_HOST_TOKENS_SECRET_NAME = var.self_host_tokens_secret_name
    SELF_HOST_TOKENS_VAULT_URL   = local.key_vault_uri_final
  }

  base_app_settings = merge(
    {
      for key, value in var.app_settings : key => value if !contains(["PORT", "NODE_OPTIONS"], key)
    },
    local.cosmos_app_settings,
    local.self_host_app_settings
  )

  base_secrets = merge(var.secrets, local.cosmos_secrets)
  base_secret_overrides = merge(
    var.secret_environment_overrides,
    { COSMOS_KEY = "cosmos-key" }
  )

  search_target_port  = 8082
  shared_node_require = "--require=/app/build/shared/enforce-auth.js"

  crawl_app_settings = merge(
    local.base_app_settings,
    {
      PORT         = tostring(var.target_port)
      NODE_OPTIONS = local.shared_node_require
    }
  )

  search_node_options = trimspace(join(" ", compact([
    local.shared_node_require,
    lookup(var.app_settings, "NODE_OPTIONS", ""),
  ])))

  search_app_settings = merge(
    local.base_app_settings,
    {
      PORT         = tostring(local.search_target_port)
      NODE_OPTIONS = local.search_node_options
    }
  )

  crawl_tags  = merge(local.common_tags, { component = "crawl" })
  search_tags = merge(local.common_tags, { component = "search" })
}

data "azurerm_client_config" "current" {}

data "azurerm_key_vault" "existing" {
  count = var.create_key_vault ? 0 : 1

  name                = var.key_vault_name
  resource_group_name = local.key_vault_rg
}

resource "azurerm_key_vault" "this" {
  count = var.create_key_vault ? 1 : 0

  name                          = var.key_vault_name
  location                      = var.location
  resource_group_name           = local.key_vault_rg
  tenant_id                     = var.tenant_id
  sku_name                      = lower(var.key_vault_sku)
  soft_delete_retention_days    = var.key_vault_soft_delete_retention_days
  purge_protection_enabled      = var.key_vault_purge_protection_enabled
  public_network_access_enabled = true

  access_policy {
    tenant_id = data.azurerm_client_config.current.tenant_id
    object_id = data.azurerm_client_config.current.object_id

    secret_permissions = [
      "Get",
      "List",
      "Set",
      "Delete",
      "Recover",
      "Backup",
      "Restore",
    ]
  }

  tags = local.common_tags
}

locals {
  key_vault_id_final  = var.create_key_vault ? (length(azurerm_key_vault.this) > 0 ? azurerm_key_vault.this[0].id : null) : (length(data.azurerm_key_vault.existing) > 0 ? data.azurerm_key_vault.existing[0].id : null)
  key_vault_uri_final = var.create_key_vault ? (length(azurerm_key_vault.this) > 0 ? azurerm_key_vault.this[0].vault_uri : "") : (length(data.azurerm_key_vault.existing) > 0 ? data.azurerm_key_vault.existing[0].vault_uri : "")
  key_vault_parent_id = "/subscriptions/${var.subscription_id}/resourceGroups/${local.key_vault_rg}"
}

module "reader_app_crawl" {
  source = "../../modules/aca/reader-app"

  rg_name                      = module.env.rg_name
  aca_env_id                   = module.env.aca_env_id
  location                     = var.location
  environment_code             = var.environment_code
  workload_name                = var.workload_name
  identifier                   = local.crawl_identifier
  subscription_id              = var.subscription_id
  container_image              = var.container_image
  registry_id                  = var.registry_id
  registry_login_server        = var.registry_login_server
  registry_username            = var.registry_username
  registry_password            = var.registry_password
  target_port                  = var.target_port
  cpu                          = var.cpu
  memory                       = var.memory
  min_replicas                 = var.min_replicas
  max_replicas                 = var.max_replicas
  ingress_external             = var.ingress_external
  ingress_allowed_cidrs        = var.ingress_allowed_cidrs
  app_settings                 = local.crawl_app_settings
  secrets                      = local.base_secrets
  secret_environment_overrides = local.base_secret_overrides
  tags                         = local.crawl_tags
}

module "reader_app_search" {
  source = "../../modules/aca/reader-app"

  rg_name                      = module.env.rg_name
  aca_env_id                   = module.env.aca_env_id
  location                     = var.location
  environment_code             = var.environment_code
  workload_name                = var.workload_name
  identifier                   = local.search_identifier
  subscription_id              = var.subscription_id
  container_image              = var.container_image
  registry_id                  = var.registry_id
  registry_login_server        = var.registry_login_server
  registry_username            = var.registry_username
  registry_password            = var.registry_password
  target_port                  = local.search_target_port
  command                      = ["node", "build/stand-alone/search.js"]
  cpu                          = var.cpu
  memory                       = var.memory
  min_replicas                 = var.min_replicas
  max_replicas                 = var.max_replicas
  ingress_external             = var.ingress_external
  ingress_allowed_cidrs        = var.ingress_allowed_cidrs
  app_settings                 = local.search_app_settings
  secrets                      = local.base_secrets
  secret_environment_overrides = local.base_secret_overrides
  tags                         = local.search_tags
}

locals {
  app_identities = {
    crawl  = module.reader_app_crawl.identity_principal_id
    search = module.reader_app_search.identity_principal_id
  }
}

resource "azurerm_cosmosdb_sql_role_assignment" "reader_app_data_contributor" {
  for_each = local.app_identities

  name                = uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "${module.cosmos.account_id}:${each.value}:data-contributor")
  resource_group_name = module.env.rg_name
  account_name        = module.cosmos.account_name
  role_definition_id  = "${module.cosmos.account_id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
  principal_id        = each.value
  scope               = module.cosmos.account_id
}

resource "azurerm_key_vault_access_policy" "apps" {
  for_each = local.key_vault_id_final != null ? {
    crawl  = module.reader_app_crawl.identity_principal_id
    search = module.reader_app_search.identity_principal_id
  } : {}

  key_vault_id = local.key_vault_id_final
  tenant_id    = var.tenant_id
  object_id    = each.value

  secret_permissions = [
    "Get",
    "List",
  ]
}

resource "azurerm_role_assignment" "key_vault_secrets_user" {
  for_each = local.key_vault_id_final != null ? {
    crawl  = module.reader_app_crawl.identity_principal_id
    search = module.reader_app_search.identity_principal_id
  } : {}

  scope                = local.key_vault_id_final
  role_definition_name = "Key Vault Secrets User"
  principal_id         = each.value
}

resource "azapi_update_resource" "key_vault_network_rules" {
  count = local.key_vault_id_final != null && length(var.key_vault_ip_rules) > 0 ? 1 : 0

  type      = "Microsoft.KeyVault/vaults@2023-07-01"
  name      = var.key_vault_name
  parent_id = local.key_vault_parent_id

  body = {
    properties = {
      networkAcls = {
        bypass        = "AzureServices"
        defaultAction = "Deny"
        ipRules       = [for ip in var.key_vault_ip_rules : { value = ip }]
      }
    }
  }
}

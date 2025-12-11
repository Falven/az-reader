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

  base_app_settings = merge(
    {
      for key, value in var.app_settings : key => value if !contains(["PORT", "NODE_OPTIONS"], key)
    },
    local.cosmos_app_settings
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

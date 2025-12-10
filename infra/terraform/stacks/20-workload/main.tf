/// Stack: 20-workload
/// Purpose: Deploy az-reader Container App using shared modules and bootstrap state

locals {
  workload_code   = lower(var.workload_name)
  env_code        = lower(var.environment_code)
  identifier      = var.identifier != "" ? lower(var.identifier) : ""
  cosmos_location = var.cosmos_location != "" ? var.cosmos_location : var.location

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

  merged_app_settings = merge(var.app_settings, local.cosmos_app_settings)
  merged_secrets      = merge(var.secrets, local.cosmos_secrets)
  merged_secret_overrides = merge(
    var.secret_environment_overrides,
    { COSMOS_KEY = "cosmos-key" }
  )
}

module "reader_app" {
  source = "../../modules/aca/reader-app"

  rg_name                      = module.env.rg_name
  aca_env_id                   = module.env.aca_env_id
  location                     = var.location
  environment_code             = var.environment_code
  workload_name                = var.workload_name
  identifier                   = var.identifier
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
  app_settings                 = local.merged_app_settings
  secrets                      = local.merged_secrets
  secret_environment_overrides = local.merged_secret_overrides
  tags                         = local.common_tags
}

resource "azurerm_cosmosdb_sql_role_assignment" "reader_app_data_contributor" {
  name                = uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "${module.cosmos.account_id}:${module.reader_app.identity_principal_id}:data-contributor")
  resource_group_name = module.env.rg_name
  account_name        = module.cosmos.account_name
  role_definition_id  = "${module.cosmos.account_id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
  principal_id        = module.reader_app.identity_principal_id
  scope               = module.cosmos.account_id
}

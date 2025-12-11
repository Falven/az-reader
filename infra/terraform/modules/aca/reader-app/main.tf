terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.55.0, < 5.0"
    }
    azapi = {
      source  = "azure/azapi"
      version = "~> 2.8.0"
    }
    modtm = {
      source  = "azure/modtm"
      version = "~> 0.3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6.0"
    }
  }
}

locals {
  env_code        = lower(var.environment_code)
  workload_code   = lower(var.workload_name)
  identifier_code = var.identifier != "" ? lower(var.identifier) : ""

  common_tags = merge({
    project     = local.workload_code
    environment = local.env_code
    location    = var.location
    role        = "app"
    managed_by  = "terraform"
  }, var.tags)

  registry_password_secret_name = var.registry_password != "" ? "acr-password" : null

  registry_segments             = var.registry_id != "" ? split("/", var.registry_id) : []
  _registry_segments_validation = var.registry_id == "" || length(local.registry_segments) >= 9 ? true : error("registry_id must be a full resource ID")
  registry_parts = var.registry_id != "" && length(local.registry_segments) >= 9 ? {
    resource_group_name = local.registry_segments[4]
    name                = local.registry_segments[8]
  } : null

  secret_map = merge(
    var.secrets,
    local.registry_password_secret_name != null ? { (local.registry_password_secret_name) = var.registry_password } : {}
  )

  env_map = merge(
    { PORT = tostring(var.target_port) },
    var.app_settings
  )

  identity_env = var.inject_identity_client_id ? [
    {
      name  = "AZURE_CLIENT_ID"
      value = azurerm_user_assigned_identity.app.client_id
    }
  ] : []

  registry_login_server = var.registry_login_server != "" ? var.registry_login_server : (
    local.registry_parts != null ? values(data.azurerm_container_registry.registry)[0].login_server : null
  )

  _registry_parts_validation = var.registry_id == "" || local.registry_parts != null ? true : error("registry_id must be a full resource ID")
  _registry_validation       = local.registry_login_server != null || (var.registry_id == "" && var.registry_login_server == "") ? true : error("Provide registry_login_server or registry_id")

  secret_objects = {
    for name, value in local.secret_map : name => {
      name  = name
      value = value
    }
  }

  container_env = concat(
    [for name, value in local.env_map : { name = name, value = value }],
    [for name, secret_name in var.secret_environment_overrides : { name = name, secret_name = secret_name }],
    local.identity_env
  )

  registry_entry = {
    server               = local.registry_login_server
    username             = var.registry_username != "" ? var.registry_username : null
    password_secret_name = local.registry_password_secret_name
    identity             = var.registry_username == "" ? azurerm_user_assigned_identity.app.id : null
  }

  registries = local.registry_login_server != null ? [local.registry_entry] : []
}

data "azurerm_container_registry" "registry" {
  for_each = local.registry_parts != null && var.registry_login_server == "" ? { registry = local.registry_parts } : {}

  name                = each.value.name
  resource_group_name = each.value.resource_group_name
}

module "naming" {
  source  = "Azure/naming/azurerm"
  version = "0.4.2"

  suffix        = compact([local.workload_code, local.env_code, local.identifier_code == "" ? null : local.identifier_code])
  unique-length = 6
}

resource "azurerm_user_assigned_identity" "app" {
  name                = module.naming.user_assigned_identity.name_unique
  location            = var.location
  resource_group_name = var.rg_name
  tags                = local.common_tags
}

resource "azurerm_role_assignment" "acr_pull" {
  count                = var.registry_id != "" ? 1 : 0
  scope                = var.registry_id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

module "app" {
  source  = "Azure/avm-res-app-containerapp/azurerm"
  version = "0.7.4"

  name                                  = module.naming.container_app.name_unique
  resource_group_name                   = var.rg_name
  container_app_environment_resource_id = var.aca_env_id
  revision_mode                         = "Single"

  managed_identities = {
    user_assigned_resource_ids = [azurerm_user_assigned_identity.app.id]
  }

  registries = local.registries

  ingress = {
    external_enabled = var.ingress_external
    target_port      = var.target_port
    # The app serves HTTP/2 only (Node http2 server), so force HTTP/2 between Envoy and the container.
    transport = "http2"
    traffic_weight = [
      {
        latest_revision = true
        percentage      = 100
      }
    ]
    ip_restrictions = [
      for cidr in var.ingress_allowed_cidrs : {
        name     = "cidr-${replace(cidr, "/", "-")}"
        action   = "Allow"
        ip_range = cidr
      }
    ]
  }

  secrets = local.secret_objects

  template = {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas
    containers = [
      {
        name    = "az-reader"
        image   = var.container_image
        cpu     = var.cpu
        memory  = var.memory
        env     = local.container_env
        command = var.command
        args    = var.args
      }
    ]
  }

  tags = local.common_tags
}

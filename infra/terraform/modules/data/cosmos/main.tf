/// Module: data/cosmos
/// Purpose: Cosmos DB account, database, and containers configured for serverless SQL API

terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.55.0, < 5.0"
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
    role        = "data"
    managed_by  = "terraform"
  }, var.tags)

  rate_limit_container = var.rate_limit_container_name != "" ? var.rate_limit_container_name : "rateLimits"

  base_containers = {
    apiRolls                    = { partition_key = "uid", ttl_seconds = null }
    jinaEmbeddingsTokenAccounts = { partition_key = "id", ttl_seconds = null }
    crawled                     = { partition_key = "urlPathDigest", ttl_seconds = 604800 }
    pdfs                        = { partition_key = "urlDigest", ttl_seconds = 604800 }
    searchResults               = { partition_key = "queryDigest", ttl_seconds = 604800 }
    SERPResults                 = { partition_key = "queryDigest", ttl_seconds = 604800 }
    serperSearchResults         = { partition_key = "queryDigest", ttl_seconds = 604800 }
    domainBlockades             = { partition_key = "domain", ttl_seconds = null }
    adaptiveCrawlTasks          = { partition_key = "id", ttl_seconds = null }
    imgAlts                     = { partition_key = "urlDigest", ttl_seconds = 604800 }
    robots                      = { partition_key = "digest", ttl_seconds = 604800 }
  }

  default_containers = merge(
    local.base_containers,
    {
      (local.rate_limit_container) = { partition_key = "key", ttl_seconds = 86400 }
    }
  )

  container_definitions = merge(local.default_containers, var.containers)
}

module "naming" {
  source  = "Azure/naming/azurerm"
  version = "0.4.2"

  suffix        = compact([local.workload_code, local.env_code, local.identifier_code == "" ? null : local.identifier_code])
  unique-length = 6
}

resource "azurerm_cosmosdb_account" "this" {
  name                = module.naming.cosmosdb_account.name_unique
  location            = var.location
  resource_group_name = var.resource_group_name

  offer_type = "Standard"
  kind       = "GlobalDocumentDB"

  automatic_failover_enabled        = false
  analytical_storage_enabled        = false
  public_network_access_enabled     = true
  is_virtual_network_filter_enabled = false
  local_authentication_disabled     = false
  free_tier_enabled                 = false

  capabilities {
    name = "EnableServerless"
  }

  consistency_policy {
    consistency_level = "Session"
  }

  geo_location {
    failover_priority = 0
    location          = var.location
    zone_redundant    = false
  }

  tags = local.common_tags
}

resource "azurerm_cosmosdb_sql_database" "this" {
  name                = lower(var.database_name)
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name
}

resource "azurerm_cosmosdb_sql_container" "containers" {
  for_each = local.container_definitions

  name                  = each.key
  resource_group_name   = var.resource_group_name
  account_name          = azurerm_cosmosdb_account.this.name
  database_name         = azurerm_cosmosdb_sql_database.this.name
  partition_key_kind    = "Hash"
  partition_key_paths   = ["/${each.value.partition_key}"]
  partition_key_version = 2
  default_ttl           = each.value.ttl_seconds != null ? each.value.ttl_seconds : -1

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }
  }

  lifecycle {
    ignore_changes = [throughput]
  }
}

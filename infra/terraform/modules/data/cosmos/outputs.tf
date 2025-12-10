output "account_name" {
  description = "Cosmos DB account name"
  value       = azurerm_cosmosdb_account.this.name
}

output "database_name" {
  description = "Cosmos SQL database name"
  value       = azurerm_cosmosdb_sql_database.this.name
}

output "endpoint" {
  description = "Cosmos DB endpoint URL"
  value       = azurerm_cosmosdb_account.this.endpoint
}

output "account_id" {
  description = "Cosmos DB account resource ID"
  value       = azurerm_cosmosdb_account.this.id
}

output "primary_key" {
  description = "Primary key for the Cosmos DB account"
  value       = azurerm_cosmosdb_account.this.primary_key
  sensitive   = true
}

output "rate_limit_container_name" {
  description = "Container name used for rate limiting"
  value       = local.rate_limit_container
}

output "container_names" {
  description = "All container names created in the database"
  value       = keys(azurerm_cosmosdb_sql_container.containers)
}

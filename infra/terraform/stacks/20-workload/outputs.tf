output "resource_group_name" {
  value       = module.env.rg_name
  description = "Workload resource group name"
}

output "crawl_container_app_name" {
  value       = module.reader_app_crawl.app_name
  description = "Crawl Container App name"
}

output "crawl_container_app_fqdn" {
  value       = module.reader_app_crawl.app_fqdn
  description = "Crawl Container App FQDN"
}

output "search_container_app_name" {
  value       = module.reader_app_search.app_name
  description = "Search Container App name"
}

output "search_container_app_fqdn" {
  value       = module.reader_app_search.app_fqdn
  description = "Search Container App FQDN"
}

output "aca_environment_id" {
  value       = module.env.aca_env_id
  description = "ACA environment ID"
}

output "crawl_identity_principal_id" {
  value       = module.reader_app_crawl.identity_principal_id
  description = "Crawl user-assigned identity principal ID"
}

output "search_identity_principal_id" {
  value       = module.reader_app_search.identity_principal_id
  description = "Search user-assigned identity principal ID"
}

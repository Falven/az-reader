output "resource_group_name" {
  value       = module.env.rg_name
  description = "Workload resource group name"
}

output "container_app_name" {
  value       = module.reader_app.app_name
  description = "Container App name"
}

output "container_app_fqdn" {
  value       = module.reader_app.app_fqdn
  description = "Container App FQDN"
}

output "aca_environment_id" {
  value       = module.env.aca_env_id
  description = "ACA environment ID"
}

output "identity_principal_id" {
  value       = module.reader_app.identity_principal_id
  description = "User-assigned identity principal ID"
}

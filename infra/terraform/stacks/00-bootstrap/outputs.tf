output "state_rg_name" {
  value       = module.state.state_rg_name
  description = "State resource group name"
}

output "state_storage_account_name" {
  value       = module.state.storage_account_name
  description = "State storage account name"
}

output "state_container_name" {
  value       = module.state.state_container_name
  description = "State container name"
}

output "state_blob_key" {
  value       = module.state.state_blob_key
  description = "Blob key for this environment"
}

output "backend_snippet" {
  value       = module.state.backend_snippet
  description = "Backend config snippet for azurerm remote state"
}

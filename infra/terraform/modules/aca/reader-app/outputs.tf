output "app_name" {
  description = "Container App name"
  value       = module.app.name
}

output "app_fqdn" {
  description = "Container App FQDN"
  value       = module.app.latest_revision_fqdn
}

output "identity_id" {
  description = "User-assigned identity resource ID"
  value       = azurerm_user_assigned_identity.app.id
}

output "identity_principal_id" {
  description = "User-assigned identity principal ID"
  value       = azurerm_user_assigned_identity.app.principal_id
}

output "identity_client_id" {
  description = "User-assigned identity client ID"
  value       = azurerm_user_assigned_identity.app.client_id
}

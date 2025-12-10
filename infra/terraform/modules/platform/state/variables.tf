/// Module: platform/state
/// Purpose: Remote state storage account, resource group, and RBAC

variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "tenant_id" {
  description = "Azure AD tenant ID"
  type        = string
}

variable "environment_code" {
  description = "Environment code"
  type        = string
}

variable "workload_name" {
  description = "Workload name used for naming"
  type        = string
}

variable "identifier" {
  description = "Optional identifier suffix"
  type        = string
  default     = ""
}

variable "location" {
  description = "Azure region"
  type        = string
}

variable "sa_replication_type" {
  description = "Storage account replication type (LRS/ZRS/GZRS/RAGZRS)"
  type        = string
  default     = "ZRS"
}

variable "soft_delete_retention_days" {
  description = "Soft delete retention for blobs"
  type        = number
  default     = 30
}

variable "state_rg_name_override" {
  description = "Optional override for state resource group name"
  type        = string
  default     = ""
}

variable "allowed_public_ip_addresses" {
  description = "IP allowlist for state storage account (optional)"
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags to apply"
  type        = map(string)
  default     = {}
}

variable "rg_name" {
  description = "Resource group name"
  type        = string
}

variable "aca_env_id" {
  description = "Container Apps environment ID"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
}

variable "environment_code" {
  description = "Environment code"
  type        = string
}

variable "workload_name" {
  description = "Workload name"
  type        = string
}

variable "identifier" {
  description = "Optional identifier"
  type        = string
  default     = ""
}

variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "container_image" {
  description = "Full container image reference"
  type        = string
}

variable "registry_id" {
  description = "ACR resource ID (optional)"
  type        = string
  default     = ""
}

variable "registry_login_server" {
  description = "Registry login server (required if registry_id not provided)"
  type        = string
  default     = ""
}

variable "registry_username" {
  description = "Registry username (optional)"
  type        = string
  default     = ""
}

variable "registry_password" {
  description = "Registry password (optional)"
  type        = string
  default     = ""
  sensitive   = true
}

variable "target_port" {
  description = "Container listening port"
  type        = number
  default     = 8080
}

variable "cpu" {
  description = "vCPU for container"
  type        = number
  default     = 0.5
}

variable "memory" {
  description = "Memory for container (Gi suffix)"
  type        = string
  default     = "1Gi"
}

variable "min_replicas" {
  description = "Minimum replicas"
  type        = number
  default     = 1
}

variable "max_replicas" {
  description = "Maximum replicas"
  type        = number
  default     = 3
}

variable "ingress_external" {
  description = "Expose app publicly"
  type        = bool
  default     = true
}

variable "ingress_allowed_cidrs" {
  description = "Optional ingress CIDR allowlist"
  type        = list(string)
  default     = []
}

variable "app_settings" {
  description = "Non-secret env vars"
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Secrets map (name -> value)"
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "secret_environment_overrides" {
  description = "Env var -> secret name mappings"
  type        = map(string)
  default     = {}
}

variable "inject_identity_client_id" {
  description = "Inject the user-assigned identity client ID as AZURE_CLIENT_ID"
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags"
  type        = map(string)
  default     = {}
}

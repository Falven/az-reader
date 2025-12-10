variable "resource_group_name" {
  description = "Name of the resource group to host Cosmos resources"
  type        = string
}

variable "location" {
  description = "Azure region for the Cosmos account"
  type        = string
}

variable "environment_code" {
  description = "Short environment code"
  type        = string
}

variable "workload_name" {
  description = "Workload name used for naming and tagging"
  type        = string
}

variable "identifier" {
  description = "Optional identifier suffix"
  type        = string
  default     = ""
}

variable "database_name" {
  description = "Cosmos SQL database name"
  type        = string
  default     = "reader"
}

variable "rate_limit_container_name" {
  description = "Container name for rate limit data"
  type        = string
  default     = "rateLimits"
}

variable "containers" {
  description = "Optional override or additional containers"
  type = map(object({
    partition_key = string
    ttl_seconds   = optional(number)
  }))
  default = {}
}

variable "tags" {
  description = "Resource tags"
  type        = map(string)
  default     = {}
}

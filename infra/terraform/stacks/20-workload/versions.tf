terraform {
  required_version = ">= 1.11, < 2.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.55.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.7.0"
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

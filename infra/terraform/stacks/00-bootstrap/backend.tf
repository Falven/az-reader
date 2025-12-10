terraform {
  # Bootstrap uses a local state file (path set by the deploy script) so we
  # can provision the remote state storage without any pre-existing backend.
  backend "local" {}
}

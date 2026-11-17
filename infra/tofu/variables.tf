variable "state_passphrase" {
  description = "Passphrase used to encrypt state and plans."
  type        = string
  sensitive   = true
}

variable "data_center_id" {
  description = "Hostinger datacenter ID in Brazil."
  type        = number
}

variable "template_id" {
  description = "Hostinger operating system template ID."
  type        = number
}


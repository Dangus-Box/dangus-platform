variable "state_passphrase" {
  description = "Frase secreta usada para criptografar o state e os planos."
  type        = string
  sensitive   = true
}

variable "data_center_id" {
  description = "ID do datacenter da Hostinger no Brasil."
  type        = number
}

variable "template_id" {
  description = "ID do template de sistema operacional da Hostinger."
  type        = number
}

variable "ssh_public_key" {
  description = "Chave pública SSH a cadastrar no Host."
  type        = string
}

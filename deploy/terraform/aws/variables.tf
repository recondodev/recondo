variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "us-east-1"
}

variable "vpc_id" {
  description = "VPC ID for the data plane (production only)"
  type        = string
  default     = ""
}

variable "subnet_ids" {
  description = "Subnet IDs for RDS and EKS (production only)"
  type        = list(string)
  default     = []
}

variable "recondo_account_id" {
  description = "Recondo control plane AWS account ID (for cross-account IAM)"
  type        = string
  default     = "000000000000"
}

variable "rds_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t4g.micro"
}

variable "s3_bucket_name" {
  description = "S3 bucket for content-addressable object storage"
  type        = string
  default     = "recondo-objects-dev"
}

variable "kms_key_alias" {
  description = "KMS key alias for encryption at rest"
  type        = string
  default     = "alias/recondo-dev"
}

variable "s3_object_lock_mode" {
  description = "S3 Object Lock mode: GOVERNANCE (default, allows GDPR deletion) or COMPLIANCE (immutable)"
  type        = string
  default     = "GOVERNANCE"

  # N3 fix: Validate that only GOVERNANCE or COMPLIANCE modes are accepted.
  # GOVERNANCE allows deletion with bypass permission (needed for GDPR).
  # COMPLIANCE makes objects truly immutable — no deletion even by root.
  validation {
    condition     = contains(["GOVERNANCE", "COMPLIANCE"], var.s3_object_lock_mode)
    error_message = "s3_object_lock_mode must be either GOVERNANCE or COMPLIANCE."
  }
}

variable "object_lock_retention_days" {
  description = "S3 Object Lock retention period in days"
  type        = number
  default     = 365
}

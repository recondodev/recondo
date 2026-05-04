terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# When environment=local, override endpoints to point at the local AWS
# emulator (MiniStack on :4566). Usage:
#   Local dev:  TF_VAR_environment=local terraform plan
#   Real AWS:   terraform plan

locals {
  is_local = var.environment == "local"
}

provider "aws" {
  region = var.aws_region

  # Local AWS emulator overrides — ignored when targeting real AWS
  s3_use_path_style           = local.is_local
  skip_credentials_validation = local.is_local
  skip_metadata_api_check     = local.is_local
  skip_requesting_account_id  = local.is_local

  access_key = local.is_local ? "test" : null
  secret_key = local.is_local ? "test" : null

  dynamic "endpoints" {
    for_each = local.is_local ? [1] : []
    content {
      s3  = "http://localhost:4566"
      kms = "http://localhost:4566"
      iam = "http://localhost:4566"
      sts = "http://localhost:4566"
      ec2 = "http://localhost:4566"
      rds = "http://localhost:4566"
      eks = "http://localhost:4566"
    }
  }
}

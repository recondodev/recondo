# IAM roles for the gateway and cross-account access.

# Gateway execution role — assumed by the gateway process (EKS pod / EC2 instance).
resource "aws_iam_role" "gateway" {
  name = "recondo-gateway-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    Project     = "recondo"
    Environment = var.environment
  }
}

# S3 access policy for the gateway
resource "aws_iam_role_policy" "gateway_s3" {
  name = "recondo-s3-access"
  role = aws_iam_role.gateway.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "s3:PutObject",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:HeadObject"
      ]
      Resource = [
        aws_s3_bucket.objects.arn,
        "${aws_s3_bucket.objects.arn}/*"
      ]
    }]
  })
}

# KMS access policy for the gateway (production only)
resource "aws_iam_role_policy" "gateway_kms" {
  count = local.is_local ? 0 : 1
  name  = "recondo-kms-access"
  role  = aws_iam_role.gateway.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "kms:Decrypt",
        "kms:GenerateDataKey"
      ]
      Resource = [aws_kms_key.recondo[0].arn]
    }]
  })
}

# Cross-account role — allows Recondo control plane to manage the data plane.
# Customer retains resource ownership; Recondo gets least-privilege ops access.
resource "aws_iam_role" "recondo_ops" {
  count = local.is_local ? 0 : 1
  name  = "recondo-ops-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = "arn:aws:iam::${var.recondo_account_id}:root" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "sts:ExternalId" = "recondo-${var.environment}" }
      }
    }]
  })

  tags = {
    Project     = "recondo"
    Environment = var.environment
  }
}

output "s3_bucket_name" {
  description = "Object store bucket name"
  value       = aws_s3_bucket.objects.id
}

output "s3_bucket_arn" {
  description = "Object store bucket ARN"
  value       = aws_s3_bucket.objects.arn
}

output "gateway_role_arn" {
  description = "Gateway IAM role ARN"
  value       = aws_iam_role.gateway.arn
}

output "kms_key_arn" {
  description = "KMS encryption key ARN (production only)"
  value       = local.is_local ? "local-dev-no-kms" : aws_kms_key.recondo[0].arn
}

# Customer-managed encryption key — SOC 2 C1 (encryption at rest).
# Production only; local dev uses the key created by
# deploy/local-dev/init-aws.sh against the MiniStack emulator.

resource "aws_kms_key" "recondo" {
  count               = local.is_local ? 0 : 1
  description         = "Recondo data encryption key"
  enable_key_rotation = true

  tags = {
    Project     = "recondo"
    Environment = var.environment
  }
}

resource "aws_kms_alias" "recondo" {
  count         = local.is_local ? 0 : 1
  name          = var.kms_key_alias
  target_key_id = aws_kms_key.recondo[0].key_id
}

# Content-addressable object store for raw request/response bytes.
# Production: S3 Object Lock (compliance mode) prevents deletion.
# Local dev: Object Lock not supported by the MiniStack emulator — versioning only.

resource "aws_s3_bucket" "objects" {
  bucket = var.s3_bucket_name

  # W4 fix: Enable Object Lock at bucket creation time (production only).
  # Object Lock requires versioning (enabled below) and must be set at
  # bucket creation — it cannot be added to an existing bucket.
  # MiniStack does not support Object Lock, so this is
  # conditional on non-local environments.
  object_lock_enabled = local.is_local ? false : true

  tags = {
    Project     = "recondo"
    Environment = var.environment
    Purpose     = "content-addressable-object-store"
  }
}

resource "aws_s3_bucket_versioning" "objects" {
  bucket = aws_s3_bucket.objects.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "objects" {
  count  = local.is_local ? 0 : 1
  bucket = aws_s3_bucket.objects.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.recondo[0].arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "objects" {
  bucket = aws_s3_bucket.objects.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Object Lock — production only (not supported by MiniStack)
resource "aws_s3_bucket_object_lock_configuration" "objects" {
  count  = local.is_local ? 0 : 1
  bucket = aws_s3_bucket.objects.id

  rule {
    default_retention {
      mode = var.s3_object_lock_mode
      days = var.object_lock_retention_days
    }
  }
}

# Lifecycle: move cold objects to cheaper storage after 90 days
resource "aws_s3_bucket_lifecycle_configuration" "objects" {
  count  = local.is_local ? 0 : 1
  bucket = aws_s3_bucket.objects.id

  rule {
    id     = "archive-cold-objects"
    status = "Enabled"

    filter {} # Apply to all objects in the bucket

    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 365
      storage_class = "GLACIER"
    }
  }
}

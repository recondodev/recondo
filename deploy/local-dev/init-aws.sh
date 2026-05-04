#!/bin/sh
# Init script — creates the AWS resources Recondo expects in local dev.
# Runs as a sidecar against MiniStack (S3-compatible AWS emulator on :4566).
# Re-runnable: every operation is idempotent so this can fire on each `up`.

set -eu

: "${AWS_ENDPOINT_URL:=http://ministack:4566}"
: "${AWS_REGION:=us-east-1}"
BUCKET="${RECONDO_S3_BUCKET:-recondo-objects-dev}"
KMS_ALIAS="alias/recondo-dev"
IAM_ROLE="recondo-gateway-role"

aws_call() {
  aws --endpoint-url="$AWS_ENDPOINT_URL" --region "$AWS_REGION" "$@"
}

echo "==> Initializing AWS resources at $AWS_ENDPOINT_URL"

# --- S3: object store for request/response bodies ---
if aws_call s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  echo "    S3 bucket: $BUCKET (already exists)"
else
  aws_call s3api create-bucket --bucket "$BUCKET" >/dev/null
  echo "    S3 bucket: $BUCKET (created)"
fi

aws_call s3api put-bucket-versioning \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled

# --- KMS: customer-managed encryption key (Terraform parity) ---
if aws_call kms describe-key --key-id "$KMS_ALIAS" >/dev/null 2>&1; then
  KEY_ID=$(aws_call kms describe-key --key-id "$KMS_ALIAS" --query 'KeyMetadata.KeyId' --output text)
  echo "    KMS key: $KMS_ALIAS ($KEY_ID, already exists)"
else
  KEY_ID=$(aws_call kms create-key \
    --description "Recondo dev encryption key" \
    --key-usage ENCRYPT_DECRYPT \
    --query 'KeyMetadata.KeyId' --output text)
  aws_call kms create-alias --alias-name "$KMS_ALIAS" --target-key-id "$KEY_ID"
  echo "    KMS key: $KMS_ALIAS ($KEY_ID, created)"
fi

# --- IAM: gateway role + policy (Terraform parity) ---
if aws_call iam get-role --role-name "$IAM_ROLE" >/dev/null 2>&1; then
  echo "    IAM role: $IAM_ROLE (already exists)"
else
  aws_call iam create-role \
    --role-name "$IAM_ROLE" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": {"Service": "ec2.amazonaws.com"},
        "Action": "sts:AssumeRole"
      }]
    }' >/dev/null
  echo "    IAM role: $IAM_ROLE (created)"
fi

# put-role-policy is idempotent — overwrites any prior version of the named policy.
aws_call iam put-role-policy \
  --role-name "$IAM_ROLE" \
  --policy-name recondo-s3-access \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Effect\": \"Allow\",
      \"Action\": [\"s3:PutObject\", \"s3:GetObject\", \"s3:ListBucket\"],
      \"Resource\": [
        \"arn:aws:s3:::$BUCKET\",
        \"arn:aws:s3:::$BUCKET/*\"
      ]
    }]
  }"

echo "==> AWS init complete."

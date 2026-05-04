# Local AWS Development with MiniStack

Recondo uses [MiniStack](https://ministack.org/) to emulate AWS services locally. This lets you develop and test the full Phase 2 infrastructure — PostgreSQL, S3 object store, KMS encryption, IAM roles, and Terraform — without an AWS account, an auth token, or any cloud spend.

MiniStack is MIT-licensed and exposes an S3/KMS/IAM/STS-compatible API on port 4566 (the same port LocalStack used historically), so the AWS SDKs, the gateway, and the Terraform module all work unchanged via `AWS_ENDPOINT_URL`.

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose)
- [Terraform CLI](https://developer.hashicorp.com/terraform/install) >= 1.5 (`brew install terraform`)
- [just](https://github.com/casey/just) command runner (`brew install just`)

## Quick Start

```bash
# Start MiniStack + PostgreSQL (and create S3 bucket / KMS key / IAM role)
just dev-infra

# Validate Terraform against MiniStack
just tf-plan
just tf-apply

# Run the gateway against local Postgres + S3
just dev-run
```

That's it. You now have a full AWS-equivalent environment on your laptop.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│  docker-compose.dev.yml                              │
│                                                      │
│  ┌──────────────────┐    ┌─────────────────────────┐ │
│  │  MiniStack       │    │  PostgreSQL 16          │ │
│  │                  │    │                         │ │
│  │  S3   → :4566    │    │  recondo DB  → :5432    │ │
│  │  KMS  → :4566    │    │  User: recondo          │ │
│  │  IAM  → :4566    │    │  Pass: recondo_dev      │ │
│  │  STS  → :4566    │    │                         │ │
│  │                  │    │  Schema:                │ │
│  │  Bucket:         │    │    sessions             │ │
│  │    recondo-      │    │    turns (immutable)    │ │
│  │    objects-dev   │    │    tool_calls           │ │
│  │  KMS key:        │    │    anomaly_events       │ │
│  │    alias/        │    │    agents               │ │
│  │    recondo-dev   │    │                         │ │
│  │  IAM role:       │    │                         │ │
│  │    recondo-      │    │                         │ │
│  │    gateway-role  │    │                         │ │
│  └──────────────────┘    └─────────────────────────┘ │
│           ▲                                          │
│           │ ministack-init sidecar (one-shot)        │
│           │ creates bucket / key / role on each up   │
│                                                      │
│  ┌──────────────────────────────────────────────────┐│
│  │  Recondo Gateway (cargo run)                     ││
│  │                                                  ││
│  │  RECONDO_STORE=postgres                          ││
│  │  RECONDO_DB_URL=postgres://...localhost:5432     ││
│  │  RECONDO_OBJECTS=s3                              ││
│  │  AWS_ENDPOINT_URL=http://localhost:4566          ││
│  └──────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

## Just Commands

| Command | What it does |
|---------|-------------|
| `just dev-infra` | Start MiniStack + PostgreSQL containers |
| `just dev-infra-down` | Stop containers (data preserved in volumes) |
| `just dev-infra-reset` | Stop containers and delete all data volumes |
| `just tf-init` | Initialize Terraform providers |
| `just tf-plan` | Terraform init + plan against MiniStack |
| `just tf-apply` | Apply Terraform to MiniStack (creates resources) |
| `just dev-run` | Start the gateway connected to local Postgres + S3 |

## File Layout

```
recondo/
├── docker-compose.dev.yml           # Container definitions
├── deploy/
│   ├── local-dev/
│   │   ├── init-aws.sh              # Idempotent: bucket/key/role
│   │   └── init-postgres.sql        # Full PostgreSQL schema
│   └── terraform/
│       └── aws/
│           ├── provider.tf           # Dual-mode provider (local / real AWS)
│           ├── variables.tf          # Input variables
│           ├── s3.tf                 # Object store bucket
│           ├── kms.tf                # Encryption key
│           ├── iam.tf                # Gateway + cross-account roles
│           └── outputs.tf            # Resource ARNs and names
```

## How It Works

### Docker Compose (`docker-compose.dev.yml`)

Starts three containers:

1. **MiniStack** — emulates S3, KMS, IAM, and STS on port 4566. Stateless image (~70MB), boots in a few seconds.

2. **`ministack-init`** — a one-shot sidecar (using `amazon/aws-cli`) that runs `deploy/local-dev/init-aws.sh` once MiniStack is healthy. The script is idempotent — it creates the S3 bucket (with versioning), the KMS key (alias `alias/recondo-dev`), and the gateway IAM role on first run, and skips them on subsequent runs. The container exits 0 once init completes; downstream services use `depends_on: condition: service_completed_successfully` to wait for it.

3. **PostgreSQL 16** — runs on port 5432 with database `recondo`, user `recondo`, password `recondo_dev`. The `init-postgres.sql` script creates the full schema including the `prevent_turn_mutation()` immutability trigger.

All services have health checks and (where applicable) persistent Docker volumes.

### Terraform Dual-Mode Provider

The Terraform module in `deploy/terraform/aws/` works against both MiniStack and real AWS. The switch is the `environment` variable:

- **`environment = "local"`** (set via `TF_VAR_environment=local terraform plan`) — routes all API calls to `http://localhost:4566`, uses dummy credentials, skips resources that the local emulator doesn't support (Object Lock, KMS-on-S3 encryption, cross-account roles).

- **`environment = "production"`** — uses real AWS credentials and creates all resources including Object Lock, KMS encryption, lifecycle policies, and cross-account IAM.

The conditional logic uses `count` on resources that only apply in production:

```hcl
locals {
  is_local = var.environment == "local"
}

# S3 Object Lock — production only
resource "aws_s3_bucket_object_lock_configuration" "objects" {
  count  = local.is_local ? 0 : 1
  ...
}
```

This means the same `.tf` files are used in both environments — no separate modules to maintain.

### PostgreSQL Schema

The `init-postgres.sql` script creates the full schema:

| Table | Purpose |
|-------|---------|
| `sessions` | Session records with agent metadata, git context, tags |
| `turns` | Immutable turn records with content hashes and object store refs |
| `tool_calls` | Tool invocations linked to turns |
| `anomaly_events` | SOC 2 audit trail for anomalies |
| `agents` | Agent registry (first seen, last seen, metadata) |

The `turns` table has a `BEFORE UPDATE OR DELETE` trigger that raises an exception on any mutation attempt — this is the PostgreSQL-level enforcement for SOC 2 PI1 (Processing Integrity).

### AWS Init Script (`init-aws.sh`)

Runs from the `ministack-init` sidecar once MiniStack is healthy. Idempotent — re-runs safely on every `up`. Creates:

- **S3 bucket** `recondo-objects-dev` with versioning enabled
- **KMS key** with alias `alias/recondo-dev`
- **IAM role** `recondo-gateway-role` with S3 access policy

These mirror what the Terraform module creates, giving you a working environment immediately without running `terraform apply` first.

## Connecting to Services Directly

### PostgreSQL

```bash
# psql
psql -h localhost -p 5432 -U recondo -d recondo

# Verify immutability trigger
psql -h localhost -U recondo -d recondo -c "
  INSERT INTO sessions (provider, system_prompt_hash)
  VALUES ('test', 'abc123')
  RETURNING id;
"
```

### MiniStack S3

```bash
# List buckets
aws --endpoint-url=http://localhost:4566 s3 ls

# Upload a test object
echo '{"test": true}' > /tmp/hello.json
aws --endpoint-url=http://localhost:4566 \
  s3 cp /tmp/hello.json s3://recondo-objects-dev/test/hello.json

# Read it back
aws --endpoint-url=http://localhost:4566 \
  s3 cp s3://recondo-objects-dev/test/hello.json -
```

### MiniStack KMS

```bash
# List key aliases
aws --endpoint-url=http://localhost:4566 kms list-aliases
```

> **Tip:** AWS CLI v2 (≥ 2.13) honors the `AWS_ENDPOINT_URL` env var, so you can drop `--endpoint-url` from every command:
>
> ```bash
> export AWS_ENDPOINT_URL=http://localhost:4566
> aws s3 ls
> aws kms list-aliases
> ```

## Deploying to Real AWS

When you're ready to test against real AWS:

1. Create a `terraform.tfvars` (git-ignored) with your real values:

```hcl
environment         = "staging"
aws_region          = "us-east-1"
vpc_id              = "vpc-0abc123..."
subnet_ids          = ["subnet-aaa", "subnet-bbb"]
recondo_account_id  = "123456789012"
s3_bucket_name      = "recondo-objects-staging"
```

2. Run with real AWS credentials:

```bash
cd deploy/terraform/aws
terraform plan -var-file=terraform.tfvars
terraform apply -var-file=terraform.tfvars
```

(Don't pass `TF_VAR_environment=local` for real-AWS runs — that would route the plan back at `localhost:4566`.)

## Why MiniStack (not LocalStack)?

We migrated from LocalStack in 2026-05 after [LocalStack's `:latest` image started requiring `LOCALSTACK_AUTH_TOKEN`](https://blog.localstack.cloud/the-road-ahead-for-localstack/) (effective 2026-03-23). MiniStack offers:

| | MiniStack | LocalStack `:latest` |
|---|---|---|
| **Auth token / signup** | None — works out of the box | Required |
| **License** | MIT | Apache (image now gated) |
| **Image size** | ~70MB compressed | ~1GB compressed |
| **Cold start** | ~3s | ~15-30s |
| **S3 / KMS / IAM / STS** | All supported | All supported |

Trade-offs: MiniStack is younger (1.3.x at time of migration) and is a one-maintainer project. The fallback if it falls short is straightforward — same port, same SDK config, same Terraform endpoints — so we can revert to LocalStack-with-token in an afternoon if needed.

## Troubleshooting

### MiniStack won't start

```bash
# Check Docker is running
docker info

# Check for port conflicts
lsof -i :4566
lsof -i :5432

# View MiniStack logs
docker compose -f docker-compose.dev.yml logs ministack
```

### `ministack-init` failed

The init sidecar exits 0 on success. If it failed, downstream services that depend on `service_completed_successfully` won't start:

```bash
# Inspect the sidecar's logs
docker compose -f docker-compose.dev.yml logs ministack-init

# Re-run manually (uses a transient container)
docker compose -f docker-compose.dev.yml run --rm ministack-init
```

### Terraform fails to connect

Make sure MiniStack is running and serving requests:

```bash
curl -i http://localhost:4566/
```

Expected: HTTP 200 with an XML `ListAllMyBucketsResult` body — that's MiniStack's S3 endpoint serving an unauthenticated list.

### PostgreSQL connection refused

```bash
# Check container is running
docker compose -f docker-compose.dev.yml ps

# Check logs
docker compose -f docker-compose.dev.yml logs postgres

# Verify you can connect
psql -h localhost -p 5432 -U recondo -d recondo -c "SELECT 1"
```

### Reset everything

```bash
just dev-infra-reset   # wipes Docker volumes
just dev-infra         # fresh start (re-runs ministack-init)
```

# Recondo BYOC Cloud Architecture

*Definitive reference for Recondo's fully managed BYOC deployment model.*
*Derived from: Network Onboarding Spec v2.0, Implementation Roadmap, Confluent/Databricks analysis.*

---

## 1. Model

**Fully managed BYOC (Bring Your Own Cloud) with inverted data plane.**

Recondo manages both the control plane and the data plane. The customer's data never leaves their cloud account. Recondo's cross-account role can manage infrastructure but cannot read data.

The customer does one thing: grant a cross-account IAM role. Recondo provisions and operates everything else.

**Industry comparison:** This is the deployment model used by Confluent Cloud Dedicated and Databricks, with one critical difference: Recondo's data privacy model is stronger.

| | Confluent BYOC | Databricks | Recondo BYOC |
|---|---|---|---|
| **Data plane location** | Confluent-managed VPC in customer's account | Customer's account | Customer's account |
| **Vendor can read data** | Yes (cross-account role has data access) | Yes (Spark executors access data directly) | **No** (explicit IAM Deny on data access) |
| **Data path** | Cross-account (customer VPC -> Confluent VPC) | Cross-account (notebooks -> customer S3) | **Intra-account** (agent -> gateway, same account) |
| **Networking for data path** | VPC Peering, Transit Gateway, or PrivateLink required | VPC Peering or PrivateLink required | **DNS routing** (automatic, zero agent changes) |
| **Auditability** | Trust vendor's access controls | Trust vendor's access controls | **Verifiable**: IAM Deny + S3 bucket policy + VPC Flow Logs |

---

## 2. Control Plane

Runs in Recondo's AWS account. Manages the full lifecycle of every customer data plane.

### Components

| Component | Purpose |
|---|---|
| **Tenant Management** | Tenant registry, onboarding API, configuration store. Stores: account ID, region, role ARN, external ID, deployment status, gateway version. |
| **Deployment Orchestrator** | Assumes customer's cross-account role via `sts:AssumeRole` with ExternalId. Runs Terraform to provision data plane resources. Deploys Helm chart to customer's EKS. |
| **Health Ingestion** | Receives heartbeats and aggregated metrics from Operators. Stores in control plane PostgreSQL. Powers the dashboard. |
| **Upgrade Dispatcher** | Sends upgrade directives to Operators when new gateway version is available. Supports automatic and change-control-gated modes. |
| **Dashboard + GraphQL API** | Web UI and API for compliance officers and CTOs. Reads metadata only from data plane. Serves: session counts, anomaly alerts, usage intelligence, compliance reports. |
| **Alerting Engine** | Receives anomaly triggers from Operators. Routes to customer-configured channels (Slack, PagerDuty, email, webhook). |
| **Billing + Metering** | Ingests usage metrics (decision counts, token counts, storage volume) from Operators. |
| **Container Registry** | ECR in Recondo's account. Hosts gateway and operator images. Customer data planes pull via ECR pull-through cache (no cross-account ECR permissions needed). |

### What the Control Plane Sees

| Data type | Visible | Example |
|---|---|---|
| Decision counts | Yes | "247 decisions captured this hour" |
| Anomaly alerts | Yes | "prompt drift detected, session ses_01J" |
| Gateway health | Yes | CPU 42%, memory 3.2GB, p99 latency 12ms |
| Latency percentiles | Yes | p50: 2ms, p95: 8ms, p99: 14ms |
| Token counts | Yes | "142,000 input tokens, 38,000 output tokens" |
| Decision content | **No** | Prompts, completions, tool calls, code |
| System prompts | **No** | Hash only (for drift detection) |
| LLM API keys | **No** | Gateway sees them in transit, never stores or transmits |
| Customer source code | **No** | Stays in customer's S3 object store |

### What the Control Plane Does NOT Have

- Access to customer's PostgreSQL (RDS). Cannot connect, cannot query.
- Access to customer's S3 objects. Cannot read captured request/response bodies.
- Access to customer's KMS plaintext. Cannot decrypt stored data.
- Any inbound network path to the customer's data plane. All communication is outbound from the data plane.

---

## 3. Data Plane

Runs in the customer's cloud account. Provisioned and managed by Recondo via cross-account role. Owned by the customer.

### Components

| Component | What it does | Where it runs |
|---|---|---|
| **Recondo Gateway** | TLS MITM proxy. Intercepts agent-to-LLM traffic. Parses requests/responses per provider (Anthropic, OpenAI, Google). Writes immutable provenance records. | EKS pod (2+ replicas, rolling update) |
| **Recondo Operator** | Lifecycle manager. Polls control plane for config. Reports health + metrics outbound. Orchestrates rolling upgrades. Only outbound communication point. | EKS pod (1 replica, leader election) |
| **PostgreSQL** | Immutable provenance graph. Sessions, turns, tool calls, anomaly events. Immutability enforced by BEFORE UPDATE/DELETE triggers. | RDS (Multi-AZ, encrypted with customer KMS) |
| **S3 Bucket** | Content-addressable object store. Gzipped raw request/response bytes. SHA-256 keyed. | S3 (Object Lock compliance mode, SSE-KMS, bucket policy denies external GetObject) |
| **KMS Key** | Encrypts PostgreSQL and S3 at rest. | AWS KMS (customer-managed, key policy owned by customer) |
| **Route 53 PHZ** | Resolves LLM API domains to Gateway IP. | Route 53 Private Hosted Zone (associated with agent VPCs) |
| **VPC** | Isolated network for all data plane components. | Dedicated VPC with private subnets (no public subnets) |

### Resource Sizing

| Resource | Specification |
|---|---|
| Compute | 4-8 vCPU, 8-16 GB RAM (scales with agent traffic) |
| PostgreSQL | 50 GB initial, gp3 SSD, auto-scales |
| S3 | Standard tier, lifecycle policies, grows with artifact volume |
| Network | 10-50 Mbps (proportional to agent traffic) |

### Data Flow

```
Agent sends request to api.anthropic.com
    |
    v
DNS resolves to Gateway IP (Route 53 PHZ)
    |
    v
Gateway receives TLS connection (SNI: api.anthropic.com)
    |
    v
Gateway generates MITM cert for api.anthropic.com (CertCache, LRU)
    |
    v
Gateway decrypts request -> SHA-256 hash of raw bytes
    |
    ├──> Raw bytes -> gzip -> S3 (content-addressable: key = hash)
    |
    ├──> Parse request: extract messages, tools, model, metadata
    |    Parse response: accumulate SSE stream, extract text/thinking/tool_calls/tokens
    |
    ├──> Write to PostgreSQL: session, turn, tool_calls (immutable, append-only)
    |
    └──> Forward request to real api.anthropic.com -> stream response back to agent
         (zero added latency: chunks forwarded immediately, accumulated in background)
```

---

## 4. Zero-Trust Data Boundary

The core security property: **Recondo can manage the customer's infrastructure but cannot read the customer's data.** This is enforced by IAM policy (not promises), verifiable by the customer, and auditable by third parties.

### Two Roles, Explicit Split

#### Infrastructure Management Role (Recondo's control plane uses this)

Used by the Deployment Orchestrator to provision and manage data plane resources.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InfrastructureManagement",
      "Effect": "Allow",
      "Action": [
        "ec2:*",
        "eks:*",
        "ecs:*",
        "rds:CreateDBInstance",
        "rds:ModifyDBInstance",
        "rds:DeleteDBInstance",
        "rds:DescribeDBInstances",
        "rds:CreateDBSnapshot",
        "s3:CreateBucket",
        "s3:PutBucketPolicy",
        "s3:PutBucketEncryption",
        "s3:PutObjectLockConfiguration",
        "s3:DeleteBucket",
        "s3:ListBucket",
        "kms:CreateKey",
        "kms:CreateAlias",
        "kms:DescribeKey",
        "kms:PutKeyPolicy",
        "iam:CreateRole",
        "iam:AttachRolePolicy",
        "iam:PassRole",
        "iam:CreateServiceLinkedRole",
        "route53:CreateHostedZone",
        "route53:ChangeResourceRecordSets",
        "route53:AssociateVPCWithHostedZone",
        "elasticloadbalancing:*",
        "logs:*",
        "cloudwatch:PutMetricData"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "${deployment_region}"
        }
      }
    },
    {
      "Sid": "DenyDataAccess",
      "Effect": "Deny",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "rds-data:ExecuteStatement",
        "rds-data:BatchExecuteStatement",
        "rds:Connect"
      ],
      "Resource": "*"
    }
  ]
}
```

The `DenyDataAccess` statement is an explicit Deny. It cannot be overridden by any Allow statement, any other policy, or any permission boundary. This is the IAM evaluation rule: explicit Deny always wins.

#### Gateway Runtime Role (runs inside customer's EKS via IRSA)

Used by the Gateway and Operator pods. Has data access only within the customer's account.

| Permission | Purpose |
|---|---|
| `s3:PutObject` on Recondo bucket | Write captured request/response bytes |
| `s3:GetObject` on Recondo bucket | Read-back for hash verification (`recondo verify`) |
| `kms:Encrypt`, `kms:GenerateDataKey` | Encrypt data at rest |
| `kms:Decrypt` | Decrypt data for verification and query |
| `ecr:GetDownloadUrlForLayer`, `ecr:BatchGetImage` | Pull gateway/operator images |

This role is an EKS IRSA (IAM Roles for Service Accounts) role — it is only assumable by the specific Kubernetes service account running the Gateway pod. It cannot be assumed from outside the cluster or from Recondo's account.

### Enforcement Mechanisms

| Mechanism | What it enforces | Who can verify |
|---|---|---|
| **IAM explicit Deny** | Recondo's cross-account role cannot call `s3:GetObject` or `rds:Connect` | Customer (IAM policy console), auditor (IAM policy document) |
| **S3 bucket policy** | Denies `GetObject` from any principal outside customer's account | Customer (S3 console), auditor |
| **RDS security group** | Port 5432 open only from Gateway SG. No public endpoint. Not reachable from Recondo's account. | Customer (VPC console, VPC Flow Logs) |
| **VPC Flow Logs** | All network traffic logged. Customer can verify no unexpected data exfiltration. | Customer (CloudWatch Logs / S3), auditor |
| **KMS key policy** | Key owned by customer's account. Recondo's infra role does not have `kms:Decrypt`. | Customer (KMS console) |
| **IAM region condition** | All infra actions restricted to customer's chosen region | Customer (IAM policy), auditor |
| **CloudTrail** | All API calls by Recondo's cross-account role logged in customer's CloudTrail | Customer (CloudTrail console), auditor |

### The Audit Story

When a SOC 2 auditor or CISO asks "How do we know Recondo can't read our data?":

1. **Show the IAM policy.** The explicit Deny on `s3:GetObject` and `rds:Connect` is visible in the customer's IAM console. It cannot be overridden.
2. **Show the S3 bucket policy.** Denies `GetObject` from any principal outside the account.
3. **Show the RDS security group.** Only the Gateway SG can reach port 5432.
4. **Show VPC Flow Logs.** All traffic is logged. No unexpected outbound data flows.
5. **Show CloudTrail.** Every API call made by Recondo's role is logged with the caller identity.

This is stronger than "we promise we won't look at your data." It's "we structurally cannot, and you can prove it."

---

## 5. Networking

### The Two Networking Problems

Recondo has two distinct networking concerns. They are independent and use different solutions.

**Problem 1: Agent -> Gateway (data path)**
How do AI agents reach the Recondo Gateway? High bandwidth, latency-sensitive. Every LLM API call flows through here.

**Problem 2: Operator -> Control Plane (management path)**
How does the Operator send metadata to Recondo Cloud? Low bandwidth (< 1 Mbps). Heartbeats, counts, latency percentiles, anomaly triggers. No decision content.

Provisioning (control plane -> data plane) is NOT a networking problem. The Deployment Orchestrator calls AWS APIs via `sts:AssumeRole`. No network path needed.

### Agent -> Gateway: DNS-Based Routing

DNS-based routing is the default in all tiers. It is Recondo's unique advantage over Confluent/Databricks.

Confluent cannot do DNS-based routing because Kafka clients connect to Confluent-specific bootstrap servers. Recondo intercepts calls to well-known public domains (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`). DNS is the perfect interception mechanism.

**How it works:**

1. Recondo creates a Route 53 Private Hosted Zone with A records:
   ```
   api.anthropic.com                      A   10.0.1.10  (Gateway IP)
   api.openai.com                         A   10.0.1.10
   generativelanguage.googleapis.com      A   10.0.1.10
   ```

2. The PHZ is associated with VPCs where agents run.

3. Agents resolve `api.anthropic.com` via standard DNS. The PHZ overrides the public DNS record within the VPC. The agent connects to the Gateway IP.

4. The Gateway receives a TLS ClientHello with SNI `api.anthropic.com`. It generates a MITM certificate for that domain, intercepts the request, captures it, and forwards to the real `api.anthropic.com`.

5. The agent sees no difference. No code changes. No HTTPS_PROXY. No SDK changes.

**Dual-mode gateway:** The gateway also supports CONNECT tunnel mode (for `HTTPS_PROXY` routing) as a fallback. It auto-detects based on the first bytes of the connection:

| First bytes | Mode | When it happens |
|---|---|---|
| `CONNECT api.anthropic.com:443` | CONNECT tunnel + TLS MITM inside tunnel | Agent configured with HTTPS_PROXY |
| TLS ClientHello (SNI: `api.anthropic.com`) | Direct TLS MITM | DNS-based routing (default) |

Both modes produce identical capture records.

### Three Networking Tiers

The tiers are additive layers, not different products. Every customer gets Tier 1. Tiers 2 and 3 add optional capabilities via Terraform variables.

#### Tier 1: Standard (default)

**Agent -> Gateway:** Route 53 PHZ associated with the Recondo VPC and any additional agent VPCs.

**Operator -> Control Plane:** Outbound HTTPS over NAT gateway to `api.recondo.ai`. TLS encrypted.

**When to use:** Agents in one VPC or a small number of VPCs. No restrictions on outbound internet. This covers 80% of deployments.

```
Agent VPC(s)                    Recondo VPC
┌──────────┐                    ┌──────────────────┐
│ Agent ───┼── DNS (PHZ) ──────>│ Gateway          │
│          │                    │ Operator ── NAT ──┼──> api.recondo.ai
└──────────┘                    └──────────────────┘
```

Terraform:
```hcl
module "recondo" {
  source             = "github.com/recondo-ai/terraform-aws-recondo//modules/cross-account-role"
  recondo_account_id = "123456789012"
  external_id        = var.recondo_external_id
  deployment_region  = "us-east-1"

  # Optional: associate PHZ with additional agent VPCs
  agent_vpc_ids = ["vpc-aaa", "vpc-bbb"]
}
```

#### Tier 2: Multi-VPC with Transit Gateway

**Agent -> Gateway:** Recondo VPC attached to the operator's existing Transit Gateway. DNS queries for LLM domains forwarded across TGW via Route 53 Resolver rules.

**Operator -> Control Plane:** Same as Tier 1 — outbound HTTPS over NAT.

**When to use:** Agents spread across many VPCs connected by Transit Gateway. Customer already has hub-and-spoke topology. This covers the next 15% of deployments.

```
VPC A ──┐                        Recondo VPC
VPC B ──┼── Transit Gateway ────>┌──────────────────┐
VPC C ──┘   (customer's)        │ Gateway          │
            Route 53 Resolver    │ Operator ── NAT ──┼──> api.recondo.ai
            rules forward DNS    └──────────────────┘
```

Terraform:
```hcl
module "recondo" {
  source             = "github.com/recondo-ai/terraform-aws-recondo//modules/cross-account-role"
  recondo_account_id = "123456789012"
  external_id        = var.recondo_external_id
  deployment_region  = "us-east-1"

  transit_gateway_id = "tgw-0abc123def456"
  agent_vpc_ids      = ["vpc-aaa", "vpc-bbb", "vpc-ccc"]
}
```

What the Terraform module does when `transit_gateway_id` is set:
- Creates a TGW attachment for the Recondo VPC
- Adds route table entries: agent VPC CIDRs -> TGW, Recondo VPC CIDR -> TGW
- Creates Route 53 Resolver outbound endpoint in Recondo VPC
- Creates Resolver rules forwarding LLM API domains to the Gateway IP
- Associates resolver rules with all agent VPCs via RAM sharing

#### Tier 3: Regulated / Zero Public Internet

**Agent -> Gateway:** Same as Tier 1 or Tier 2.

**Operator -> Control Plane:** PrivateLink. Recondo publishes a VPC endpoint service (NLB-backed) in Recondo's account. Terraform creates an Interface VPC Endpoint in the customer's Recondo VPC. No NAT gateway. No public internet exposure.

**When to use:** Banks, defense, healthcare with a policy of zero public internet traffic from production workloads. This covers the remaining 5%.

```
Recondo VPC
┌──────────────────┐
│ Gateway          │                    Recondo Cloud
│ Operator ────────┼── PrivateLink ──> (endpoint service)
│ (no NAT, no      │
│  public internet) │
└──────────────────┘
```

Terraform:
```hcl
module "recondo" {
  source             = "github.com/recondo-ai/terraform-aws-recondo//modules/cross-account-role"
  recondo_account_id = "123456789012"
  external_id        = var.recondo_external_id
  deployment_region  = "us-east-1"

  private_connectivity = "privatelink"

  # Can combine with Tier 2:
  transit_gateway_id = "tgw-0abc123def456"
  agent_vpc_ids      = ["vpc-aaa", "vpc-bbb"]
}
```

What the Terraform module does when `private_connectivity = "privatelink"`:
- Creates an Interface VPC Endpoint pointing to Recondo's endpoint service
- Creates a security group allowing outbound 443 to the endpoint only
- Does NOT create a NAT gateway (no public internet path)
- Operator configuration uses the VPC endpoint DNS name instead of `api.recondo.ai`

#### Tier Comparison

| | Tier 1: Standard | Tier 2: Multi-VPC | Tier 3: Regulated |
|---|---|---|---|
| **Agent -> Gateway** | PHZ + VPC association | PHZ + TGW + Resolver rules | Same as Tier 1 or 2 |
| **Operator -> Control Plane** | Outbound HTTPS (NAT) | Outbound HTTPS (NAT) | PrivateLink (no NAT) |
| **Public internet exposure** | Operator outbound only (metadata) | Operator outbound only (metadata) | None |
| **Customer prerequisite** | None | Existing Transit Gateway | None |
| **Terraform variables** | `agent_vpc_ids` (optional) | `transit_gateway_id` + `agent_vpc_ids` | `private_connectivity = "privatelink"` |
| **Estimated customers** | 80% | 15% | 5% |

### Fallback: Proxy-Based Routing

For environments where DNS-based routing is not suitable (agents outside AWS, local development, multi-cloud agents):

| Method | Configuration |
|---|---|
| **Host/cluster-level proxy** | `HTTPS_PROXY=http://<gateway-ip>:8443` at the infrastructure layer |
| **Per-agent env var** | `HTTPS_PROXY=http://<gateway-ip>:8443` in the agent's environment |

Proxy-based routing uses the CONNECT tunnel path in the gateway. Same capture, same provenance records.

---

## 6. Operator -> Control Plane Protocol

### Outbound Traffic Inventory

The following is the complete list of what the Operator transmits. Nothing else is transmitted. All traffic is outbound-only from the data plane.

| Data Type | Content | Frequency | Size |
|---|---|---|---|
| **Heartbeat** | Gateway version, uptime, component health (gateway, PostgreSQL, S3). No decision data. | Every 60s | ~500 bytes |
| **Decision count metrics** | Rolling counts by provider, model, and agent framework. No content. | Every 5 min | ~2 KB |
| **Anomaly triggers** | Anomaly type, session ID, timestamp, severity. No content. | On detection | ~200 bytes |
| **Latency percentiles** | p50/p95/p99 of the interception layer. No content. | Every 5 min | ~100 bytes |
| **Config acknowledgements** | Confirmation that a config update was applied. No decision data. | On config change | ~100 bytes |
| **Authorized report exports** | Structured compliance evidence compiled on-premise. Requires explicit dashboard approval before transmission. | On demand | Variable |

**Average outbound bandwidth:** < 50 KB/min. Under 1 Mbps sustained.

### Connection Drop Behavior

If the outbound connection to Recondo Cloud is interrupted:

- **Decision capture continues.** Gateway writes to PostgreSQL and S3 independently.
- **Anomaly detection continues locally.**
- **No data is lost.** Operator buffers telemetry and synchronizes on reconnection.
- **Only impact:** Dashboard shows gateway offline. No new alerts delivered until reconnection.

Recondo's capture guarantee -- required for SOC 2 processing integrity -- is maintained entirely within the customer's account and is independent of connectivity to the control plane.

---

## 7. Upgrade Flow

1. Recondo builds new gateway image, pushes to Recondo ECR, runs automated tests.
2. Control plane marks the new version as available.
3. Upgrade Dispatcher sends directive to Operator via management channel (HTTPS or PrivateLink).
4. Operator pulls new image via ECR pull-through cache in customer's account.
5. Operator performs Kubernetes rolling update:
   - New pods start with new image
   - Readiness probe passes (health check on `/healthz`)
   - Old pods begin draining (existing connections complete, no new connections)
   - Old pods terminate
6. If readiness probe fails on new pods: automatic rollback to previous image.
7. Operator reports upgrade result to control plane.

### Change Control Mode

For customers that require approval before upgrades (e.g., ITIL change management):

1. Upgrade Dispatcher sends directive to Operator.
2. Operator pauses and reports "upgrade pending approval" to control plane.
3. Dashboard shows pending upgrade with version details and changelog.
4. Customer's change manager clicks **Approve** in dashboard.
5. Operator proceeds with rolling update.
6. If no approval within configurable window (default 7 days): upgrade remains pending, no action taken.

---

## 8. Multi-Cloud

Same fully managed BYOC model on every cloud. The gateway binary is identical. Only the infrastructure automation and cross-account mechanism differ.

### Cross-Account Mechanisms

| Cloud | Mechanism | How it works | Credentials exchanged |
|---|---|---|---|
| **AWS** | IAM cross-account role | Customer creates role trusting Recondo's account ID + ExternalId. Recondo assumes via `sts:AssumeRole`. | None. STS temporary credentials only. |
| **GCP** | Workload Identity Federation | Customer creates service account + WIF pool trusting Recondo's OIDC provider. Recondo authenticates via federated token exchange. | None. No service account keys. |
| **Azure** | Service Principal + federated credentials | Customer registers Recondo's Azure AD app + grants Contributor on a resource group. Recondo authenticates via federated credential (no client secret). | None. No client secrets. |

### Per-Cloud Resource Mapping

| Component | AWS | GCP | Azure |
|---|---|---|---|
| **Compute** | EKS (managed node groups or Fargate) | GKE Autopilot | AKS |
| **Database** | RDS PostgreSQL (Multi-AZ) | Cloud SQL for PostgreSQL | Azure Database for PG Flexible Server |
| **Object Store** | S3 (Object Lock, SSE-KMS) | Cloud Storage (CMEK) | Blob Storage (CMK) |
| **Encryption** | AWS KMS (customer-managed key) | Cloud KMS (customer-managed key) | Azure Key Vault (customer-managed key) |
| **DNS Routing** | Route 53 Private Hosted Zone | Cloud DNS Private Zone | Azure Private DNS Zone |
| **Private Connectivity** | PrivateLink (Interface VPC Endpoint) | Private Service Connect | Private Endpoint |
| **Multi-VPC Routing** | Transit Gateway | Shared VPC or VPC Peering | VNet Peering or Virtual WAN |
| **Traffic Logging** | VPC Flow Logs | VPC Flow Logs | NSG Flow Logs |
| **API Audit** | CloudTrail | Cloud Audit Logs | Azure Activity Log |

### Data Residency

Customer picks a deployment region at onboarding. The entire data plane deploys in that region only. Enforced by:

- **AWS:** `aws:RequestedRegion` IAM condition on cross-account role
- **GCP:** Resource location constraint on the service account
- **Azure:** Allowed locations Azure Policy on the resource group

Recondo cannot create resources in any other region.

**Supported regions:**

| Cloud | Regions |
|---|---|
| **AWS** | us-east-1, us-west-2, eu-west-1, eu-central-1, ap-southeast-1, ap-northeast-1 |
| **GCP** | us-central1, us-east1, europe-west1, asia-southeast1 |
| **Azure** | eastus, westus2, westeurope, southeastasia |

Other regions available on request.

### Multi-Region

For global enterprises, the control plane manages N data planes per tenant (one per region):

- Tenant configuration: `regions: ["us-east-1", "eu-west-1"]`
- Separate, isolated data planes in each region
- No cross-region data movement
- Unified dashboard view across regions
- Regional data residency enforced per data plane

---

## 9. Customer Onboarding

### What the Customer Does

**One thing: grant a cross-account role.**

They do not carve subnets. They do not create VPC endpoints. They do not install Helm charts. They do not configure DNS. They do not provision databases.

### Path A: CloudFormation Quick-Create (10 minutes)

1. Log into Recondo dashboard -> click **Add Environment** -> select cloud + region
2. Click **Launch Stack** -> CloudFormation console opens with pre-filled template
3. Review the role (two managed policies: InfraManagement + DenyDataAccess) -> click Create
4. Paste role ARN into Recondo dashboard -> click **Deploy**
5. Recondo provisions everything (~30 min automated)
6. Dashboard shows green. First captures appear.

### Path B: Terraform Module (15 minutes)

```hcl
module "recondo" {
  source             = "github.com/recondo-ai/terraform-aws-recondo//modules/cross-account-role"
  recondo_account_id = "123456789012"
  external_id        = var.recondo_external_id
  deployment_region  = "us-east-1"

  # Optional overrides:
  # existing_vpc_id      = "vpc-existing"
  # agent_vpc_ids        = ["vpc-aaa", "vpc-bbb"]
  # transit_gateway_id   = "tgw-0abc123def456"
  # private_connectivity = "privatelink"
}
```

`terraform plan` -> review -> `terraform apply` -> paste role ARN -> click Deploy.

### Onboarding Checklist

| Item | Required | Notes |
|---|---|---|
| Cloud account ID | Yes | AWS account ID, GCP project ID, or Azure subscription ID |
| Deployment region | Yes | Where the data plane will run |
| Cross-account role granted | Yes | CloudFormation (Path A) or Terraform (Path B) |
| LLM provider domains | Yes | `api.anthropic.com`, `api.openai.com`, etc. |
| Existing VPC (optional) | No | Only if data plane must be in a specific VPC |
| Transit Gateway ID (optional) | No | Only for Tier 2 multi-VPC deployments |
| Private connectivity (optional) | No | Only for Tier 3 zero-public-internet deployments |
| Change control process | No | If upgrades require approval |
| Compliance contact | No | Who uses the dashboard |

### Timeline

| Phase | Duration | Who |
|---|---|---|
| Grant cross-account role | 10 min | Customer |
| Automated provisioning | ~30 min | Recondo (automated) |
| First captures visible | < 1 hour | -- |

---

## 10. Terminology

Standard terms used in this architecture.

| Term | Definition |
|---|---|
| **BYOC (Bring Your Own Cloud)** | The operator provides the cloud account and runs the software inside it. |
| **Control plane / data plane separation** | Management layer and data processing layer run in different trust boundaries. |
| **Customer-managed keys (CMK)** | Encryption keys stored in the operator's KMS. The gateway uses them but cannot extract them. |
| **Cross-account role** | IAM role in the operator's account that a managing process can assume. Industry-standard trust mechanism. |
| **Zero-trust data boundary** | A management layer that can manage infrastructure but cannot read data. Enforced by IAM, not by promises. |
| **Tenant isolation** | Each tenant's data plane is physically separated. No shared databases, compute, or storage. |
| **Data residency** | Data stored and processed only in a specified region. Enforced by IAM conditions. |
| **Immutable audit trail** | Records cannot be modified or deleted. Enforced by database triggers and S3 Object Lock. |

### Terminology to avoid

| Do not say | Say instead | Why |
|---|---|---|
| "On-premise" | "In your cloud account" | On-premise implies physical hardware the operator manages |
| "Hybrid cloud" | "BYOC" or "operator VPC deployment" | Hybrid implies on-prem + cloud split |
| "Data never leaves your network" | "Data never leaves your cloud account" | Be precise — data traverses the VPC network to RDS/S3, but never leaves the account boundary |

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DataTable } from "../components/DataTable";
import { TagPill } from "../components/TagPill";
import { ChartBox } from "../components/ChartBox";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { graphqlRequest, extractField } from "../graphql/client";
import type {
  PolicyItem,
  PolicyConnection,
  TrendDataPoint,
} from "../types/graphql";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const POLICIES_QUERY = `
  query Policies($limit: Int, $offset: Int) {
    policies(limit: $limit, offset: $offset) {
      items {
        id
        name
        type
        scope
        action
        triggersMtd
        status
      }
      total
      limit
      offset
    }
  }
`;

const POLICY_TRIGGER_HISTORY_QUERY = `
  query PolicyTriggerHistory($days: Int) {
    policyTriggerHistory(days: $days) {
      label
      value
    }
  }
`;

const CREATE_POLICY_MUTATION = `
  mutation CreatePolicy($input: CreatePolicyInput!) {
    createPolicy(input: $input) {
      policy {
        id
        name
        type
        scope
        action
        triggersMtd
        status
      }
      errors {
        field
        code
        message
      }
    }
  }
`;

const UPDATE_POLICY_MUTATION = `
  mutation UpdatePolicy($id: ID!, $input: UpdatePolicyInput!) {
    updatePolicy(id: $id, input: $input) {
      policy {
        id
        name
        type
        scope
        action
        triggersMtd
        status
      }
      errors {
        field
        code
        message
      }
    }
  }
`;

const DELETE_POLICY_MUTATION = `
  mutation DeletePolicy($id: ID!) {
    deletePolicy(id: $id) {
      success
      errors {
        field
        code
        message
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Policy type options
// ---------------------------------------------------------------------------

const POLICY_TYPE_OPTIONS = ["BLOCK", "LIMIT", "ALERT", "MONITOR"];

const SCOPE_OPTIONS = ["All Agents", "Production", "Staging", "Engineering"];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Policies() {
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState(POLICY_TYPE_OPTIONS[0]);
  const [newScope, setNewScope] = useState(SCOPE_OPTIONS[0]);
  const [newAction, setNewAction] = useState("");

  // Policies list
  const policiesQuery = useQuery({
    queryKey: ["policies"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        POLICIES_QUERY,
        { limit: 20, offset: 0 },
        "Policies",
        signal,
      );
      return extractField<PolicyConnection>(raw, "policies");
    },
  });

  // Trigger history
  const triggerHistoryQuery = useQuery({
    queryKey: ["policyTriggerHistory"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        POLICY_TRIGGER_HISTORY_QUERY,
        { days: 7 },
        "PolicyTriggerHistory",
        signal,
      );
      return extractField<TrendDataPoint[]>(raw, "policyTriggerHistory");
    },
    refetchOnWindowFocus: false,
  });

  // Create policy mutation
  const createMutation = useMutation({
    mutationFn: async (vars: { name: string; type: string; scope: string; action: string }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        CREATE_POLICY_MUTATION,
        { input: { name: vars.name, type: vars.type, scope: vars.scope, action: vars.action } },
        "CreatePolicy",
      );
      return extractField<unknown>(raw, "createPolicy");
    },
    onSuccess: (data) => {
      const payload = data as Record<string, unknown> | null;
      const errors = (payload as { errors?: unknown[] } | null)?.errors;
      if (errors && errors.length > 0) return;
      queryClient.invalidateQueries({ queryKey: ["policies"] });
      queryClient.invalidateQueries({ queryKey: ["policyTriggerHistory"] });
      setShowCreateForm(false);
      setNewName("");
      setNewType(POLICY_TYPE_OPTIONS[0]);
      setNewScope(SCOPE_OPTIONS[0]);
      setNewAction("");
    },
  });

  // Update policy mutation
  const updateMutation = useMutation({
    mutationFn: async (vars: { id: string; input: { status: string } }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        UPDATE_POLICY_MUTATION,
        { id: vars.id, input: vars.input },
        "UpdatePolicy",
      );
      return extractField<unknown>(raw, "updatePolicy");
    },
    onSuccess: (data) => {
      const payload = data as Record<string, unknown> | null;
      const errors = (payload as { errors?: unknown[] } | null)?.errors;
      if (errors && errors.length > 0) return;
      queryClient.invalidateQueries({ queryKey: ["policies"] });
    },
  });

  // Delete policy mutation
  const deleteMutation = useMutation({
    mutationFn: async (vars: { id: string }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        DELETE_POLICY_MUTATION,
        { id: vars.id },
        "DeletePolicy",
      );
      return extractField<unknown>(raw, "deletePolicy");
    },
    onSuccess: (data) => {
      const payload = data as Record<string, unknown> | null;
      const errors = (payload as { errors?: unknown[] } | null)?.errors;
      if (errors && errors.length > 0) return;
      queryClient.invalidateQueries({ queryKey: ["policies"] });
      queryClient.invalidateQueries({ queryKey: ["policyTriggerHistory"] });
    },
  });

  const handleCreateSubmit = useCallback(() => {
    if (!newName.trim() || !newAction.trim()) return;
    createMutation.mutate({
      name: newName,
      type: newType,
      scope: newScope,
      action: newAction,
    });
  }, [createMutation, newName, newType, newScope, newAction]);

  const handleToggleStatus = useCallback(
    (policy: PolicyItem) => {
      const nextStatus = policy.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
      updateMutation.mutate({ id: policy.id, input: { status: nextStatus } });
    },
    [updateMutation],
  );

  const handleDelete = useCallback(
    (policy: PolicyItem) => {
      if (!window.confirm(`Are you sure you want to delete policy "${policy.name}"?`)) {
        return;
      }
      deleteMutation.mutate({ id: policy.id });
    },
    [deleteMutation],
  );

  // ---------------------------------------------------------------------------
  // Table columns
  // ---------------------------------------------------------------------------

  const columns = [
    {
      key: "name",
      header: "Name",
      render: (row: PolicyItem) => row.name,
      sortable: true,
      getSortValue: (row: PolicyItem) => row.name,
    },
    {
      key: "type",
      header: "Type",
      render: (row: PolicyItem) => (
        <TagPill variant="policy" label={row.type} />
      ),
      sortable: true,
      getSortValue: (row: PolicyItem) => row.type,
    },
    {
      key: "scope",
      header: "Scope",
      render: (row: PolicyItem) => row.scope,
      sortable: true,
      getSortValue: (row: PolicyItem) => row.scope,
    },
    {
      key: "action",
      header: "Action",
      render: (row: PolicyItem) => row.action,
      sortable: true,
      getSortValue: (row: PolicyItem) => row.action,
    },
    {
      key: "triggersMtd",
      header: "Triggers MTD",
      render: (row: PolicyItem) => String(row.triggersMtd),
      sortable: true,
      getSortValue: (row: PolicyItem) => row.triggersMtd,
    },
    {
      key: "status",
      header: "Status",
      render: (row: PolicyItem) => (
        <button
          data-status={row.status}
          onClick={(e) => {
            e.stopPropagation();
            handleToggleStatus(row);
          }}
          style={{ cursor: "pointer", background: "none", border: "none", padding: 0 }}
        >
          <TagPill
            variant="status"
            label={row.status}
            className={row.status === "ACTIVE" ? "tag-ok" : "tag-warn"}
          />
        </button>
      ),
      sortable: true,
      getSortValue: (row: PolicyItem) => row.status,
    },
    {
      key: "delete",
      header: "",
      render: (row: PolicyItem) => (
        <button
          aria-label={`Delete policy ${row.name}`}
          onClick={(e) => {
            e.stopPropagation();
            handleDelete(row);
          }}
        >
          Delete
        </button>
      ),
    },
  ];

  // ---------------------------------------------------------------------------
  // Loading / Error
  // ---------------------------------------------------------------------------

  const allLoading = policiesQuery.isLoading || triggerHistoryQuery.isLoading;

  const anyError = policiesQuery.isError || triggerHistoryQuery.isError;

  const errorMessage =
    policiesQuery.error?.message ||
    triggerHistoryQuery.error?.message ||
    "Failed to load policies data";

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------

  const policies = policiesQuery.data?.items ?? [];
  const triggerHistory = triggerHistoryQuery.data ?? [];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div aria-live="polite">
      <div className="header">
        <h2>Governance Policies</h2>
        <span className="text-dim">
          Define and manage rules for AI usage compliance
        </span>
      </div>

      <div style={{ marginBottom: "12px" }}>
        <button
          onClick={() => setShowCreateForm(true)}
          aria-label="New Policy"
        >
          + New Policy
        </button>
      </div>

      {/* Create policy form */}
      {showCreateForm && (
        <div
          style={{
            padding: "16px",
            border: "1px solid var(--border, #333)",
            borderRadius: "8px",
            marginBottom: "16px",
          }}
        >
          <h3>Create New Policy</h3>

          <label htmlFor="policy-name" style={{ display: "block", marginTop: "8px" }}>
            Name
          </label>
          <input
            id="policy-name"
            name="name"
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Policy name"
            aria-label="Name"
          />

          <label htmlFor="policy-type" style={{ display: "block", marginTop: "8px" }}>
            Type
          </label>
          <select
            id="policy-type"
            name="type"
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
            aria-label="Type"
          >
            {POLICY_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <label htmlFor="policy-scope" style={{ display: "block", marginTop: "8px" }}>
            Scope
          </label>
          <select
            id="policy-scope"
            name="scope"
            value={newScope}
            onChange={(e) => setNewScope(e.target.value)}
            aria-label="Scope"
          >
            {SCOPE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <label htmlFor="policy-action" style={{ display: "block", marginTop: "8px" }}>
            Action
          </label>
          <input
            id="policy-action"
            name="action"
            type="text"
            value={newAction}
            onChange={(e) => setNewAction(e.target.value)}
            placeholder="Policy action description"
            aria-label="Action"
          />

          {createMutation.isError && (
            <p style={{ color: "var(--red, #ef4444)" }}>
              {createMutation.error?.message ?? "Creation failed"}
            </p>
          )}

          <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
            <button
              onClick={handleCreateSubmit}
              disabled={!newName.trim() || !newAction.trim() || createMutation.isPending}
            >
              Submit
            </button>
            <button onClick={() => setShowCreateForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {allLoading ? (
        <LoadingState message="Loading policies data..." />
      ) : anyError ? (
        <ErrorState message={errorMessage} />
      ) : (
        <>
          {/* Policies table */}
          {policies.length === 0 ? (
            <EmptyState message="No policies found. Create your first policy above." />
          ) : (
            <DataTable
              columns={columns}
              data={policies}
              rowKey={(row) => row.id}
              ariaLabel="Governance policies table"
            />
          )}

          {/* Trigger history chart */}
          <div style={{ marginTop: "24px" }}>
            <ChartBox title="Trigger History (7 Day)">
              {triggerHistory.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={triggerHistory}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="label" tick={{ fill: "var(--text-dim)" }} />
                    <YAxis tick={{ fill: "var(--text-dim)" }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "var(--surface)",
                        border: "1px solid var(--border)",
                        color: "var(--text)",
                      }}
                    />
                    <Bar dataKey="value" fill="var(--accent, #6366f1)" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-dim">No trigger data available</p>
              )}
            </ChartBox>
          </div>
        </>
      )}
    </div>
  );
}

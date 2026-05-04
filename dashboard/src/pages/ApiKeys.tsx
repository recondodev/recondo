import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DataTable } from "../components/DataTable";
import { TagPill } from "../components/TagPill";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { graphqlRequest, extractField } from "../graphql/client";
import type {
  RegisteredKeyItem,
  KeyConnection,
} from "../types/graphql";

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const REGISTERED_KEYS_QUERY = `
  query RegisteredKeys($limit: Int, $offset: Int) {
    registeredKeys(limit: $limit, offset: $offset) {
      items {
        id
        name
        provider
        fingerprint
        agentCount
        lastUsed
        monthlyCostUsd
        status
      }
      total
      limit
      offset
    }
  }
`;

const REGISTER_KEY_MUTATION = `
  mutation RegisterKey($input: RegisterKeyInput!) {
    registerKey(input: $input) {
      key {
        id
        name
        provider
        fingerprint
        agentCount
        lastUsed
        monthlyCostUsd
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

const DELETE_KEY_MUTATION = `
  mutation DeleteKey($id: ID!) {
    deleteKey(id: $id) {
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
// Provider options
// ---------------------------------------------------------------------------

const PROVIDER_OPTIONS = ["Anthropic", "OpenAI", "Google", "Azure", "AWS"];

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function formatCurrency(value: number): string {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatLastUsed(dateStr: string | null): string {
  if (!dateStr) return "--";
  const date = new Date(dateStr);
  return date.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ApiKeys() {
  const queryClient = useQueryClient();
  const [showRegisterForm, setShowRegisterForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newProvider, setNewProvider] = useState(PROVIDER_OPTIONS[0]);
  const [newFingerprint, setNewFingerprint] = useState("");

  // Registered keys list
  const keysQuery = useQuery({
    queryKey: ["registeredKeys"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        REGISTERED_KEYS_QUERY,
        { limit: 20, offset: 0 },
        "RegisteredKeys",
        signal,
      );
      return extractField<KeyConnection>(raw, "registeredKeys");
    },
  });

  // Register key mutation
  const registerMutation = useMutation({
    mutationFn: async (vars: { name: string; provider: string; fingerprint: string }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        REGISTER_KEY_MUTATION,
        { input: { name: vars.name, provider: vars.provider, fingerprint: vars.fingerprint } },
        "RegisterKey",
      );
      return extractField<unknown>(raw, "registerKey");
    },
    onSuccess: (data) => {
      const payload = data as Record<string, unknown> | null;
      const errors = (payload as { errors?: unknown[] } | null)?.errors;
      if (errors && errors.length > 0) return;
      queryClient.invalidateQueries({ queryKey: ["registeredKeys"] });
      setShowRegisterForm(false);
      setNewName("");
      setNewProvider(PROVIDER_OPTIONS[0]);
      setNewFingerprint("");
    },
  });

  // Delete key mutation
  const deleteMutation = useMutation({
    mutationFn: async (vars: { id: string }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        DELETE_KEY_MUTATION,
        { id: vars.id },
        "DeleteKey",
      );
      return extractField<unknown>(raw, "deleteKey");
    },
    onSuccess: (data) => {
      const payload = data as Record<string, unknown> | null;
      const errors = (payload as { errors?: unknown[] } | null)?.errors;
      if (errors && errors.length > 0) return;
      queryClient.invalidateQueries({ queryKey: ["registeredKeys"] });
    },
  });

  const handleRegisterSubmit = useCallback(() => {
    if (!newName.trim() || !newFingerprint.trim()) return;
    registerMutation.mutate({
      name: newName,
      provider: newProvider,
      fingerprint: newFingerprint,
    });
  }, [registerMutation, newName, newProvider, newFingerprint]);

  const handleDelete = useCallback(
    (key: RegisteredKeyItem) => {
      if (!window.confirm(`Are you sure you want to delete key "${key.name}"?`)) {
        return;
      }
      deleteMutation.mutate({ id: key.id });
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
      render: (row: RegisteredKeyItem) => row.name,
      sortable: true,
      getSortValue: (row: RegisteredKeyItem) => row.name,
    },
    {
      key: "provider",
      header: "Provider",
      render: (row: RegisteredKeyItem) => (
        <TagPill variant="provider" label={row.provider} />
      ),
      sortable: true,
      getSortValue: (row: RegisteredKeyItem) => row.provider,
    },
    {
      key: "fingerprint",
      header: "Fingerprint",
      render: (row: RegisteredKeyItem) => (
        <span className="mono">{row.fingerprint}</span>
      ),
      sortable: true,
      getSortValue: (row: RegisteredKeyItem) => row.fingerprint,
    },
    {
      key: "agents",
      header: "Agents",
      render: (row: RegisteredKeyItem) => String(row.agentCount),
      sortable: true,
      getSortValue: (row: RegisteredKeyItem) => row.agentCount,
    },
    {
      key: "lastUsed",
      header: "Last Used",
      render: (row: RegisteredKeyItem) => formatLastUsed(row.lastUsed),
      sortable: true,
      // Sort by raw timestamp, not formatted "5m ago" string, so order stays
      // chronological even when display strings are localized.
      getSortValue: (row: RegisteredKeyItem) => row.lastUsed ?? null,
    },
    {
      key: "monthlyCost",
      header: "Monthly Spend",
      render: (row: RegisteredKeyItem) => formatCurrency(row.monthlyCostUsd),
      sortable: true,
      getSortValue: (row: RegisteredKeyItem) => row.monthlyCostUsd,
    },
    {
      key: "status",
      header: "Status",
      render: (row: RegisteredKeyItem) => (
        <TagPill variant="status" label={row.status} />
      ),
      sortable: true,
      getSortValue: (row: RegisteredKeyItem) => row.status,
    },
    {
      key: "delete",
      header: "",
      render: (row: RegisteredKeyItem) => (
        <button
          aria-label={`Delete key ${row.name}`}
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

  const isLoading = keysQuery.isLoading;
  const isError = keysQuery.isError;
  const errorMessage = keysQuery.error?.message || "Failed to load API keys data";

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------

  const keys = keysQuery.data?.items ?? [];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div aria-live="polite">
      <div className="header">
        <h2>API Key Attribution</h2>
        <span className="text-dim">
          Keys are never stored — only SHA-256 hashes are used for attribution
        </span>
      </div>

      {!showRegisterForm && (
        <div style={{ marginBottom: "12px" }}>
          <button
            onClick={() => setShowRegisterForm(true)}
            aria-label="Register Key"
          >
            + Register Key
          </button>
        </div>
      )}

      {/* Register key form */}
      {showRegisterForm && (
        <div
          style={{
            padding: "16px",
            border: "1px solid var(--border, #333)",
            borderRadius: "8px",
            marginBottom: "16px",
          }}
        >
          <h3>Register New Key</h3>

          <label htmlFor="key-name" style={{ display: "block", marginTop: "8px" }}>
            Name
          </label>
          <input
            id="key-name"
            name="name"
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Key name"
            aria-label="Name"
          />

          <label htmlFor="key-provider" style={{ display: "block", marginTop: "8px" }}>
            Provider
          </label>
          <select
            id="key-provider"
            name="provider"
            value={newProvider}
            onChange={(e) => setNewProvider(e.target.value)}
            aria-label="Provider"
          >
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>

          <label htmlFor="key-fingerprint" style={{ display: "block", marginTop: "8px" }}>
            Fingerprint
          </label>
          <input
            id="key-fingerprint"
            name="fingerprint"
            type="text"
            value={newFingerprint}
            onChange={(e) => setNewFingerprint(e.target.value)}
            placeholder="sha256:..."
            aria-label="Fingerprint"
          />

          {registerMutation.isError && (
            <p style={{ color: "var(--red, #ef4444)" }}>
              {registerMutation.error?.message ?? "Registration failed"}
            </p>
          )}

          <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
            <button
              onClick={handleRegisterSubmit}
              disabled={!newName.trim() || !newFingerprint.trim() || registerMutation.isPending}
            >
              Submit
            </button>
            <button onClick={() => setShowRegisterForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {isLoading ? (
        <LoadingState message="Loading API keys data..." />
      ) : isError ? (
        <ErrorState message={errorMessage} />
      ) : (
        <>
          {/* Keys table */}
          {keys.length === 0 ? (
            <EmptyState message="No keys registered. Register your first key above." />
          ) : (
            <DataTable
              columns={columns}
              data={keys}
              rowKey={(row) => row.id}
              ariaLabel="API keys table"
            />
          )}
        </>
      )}
    </div>
  );
}

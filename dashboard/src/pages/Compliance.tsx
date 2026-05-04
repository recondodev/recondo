import { useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { MetricCard } from "../components/MetricCard";
import { ProgressBar } from "../components/ProgressBar";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { graphqlRequest, extractField } from "../graphql/client";
import type {
  ComplianceSummary,
  ComplianceFramework,
} from "../types/graphql";

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const COMPLIANCE_SUMMARY_QUERY = `
  query ComplianceSummary {
    complianceSummary {
      overallScore
      captureIntegrity
      droppedEvents
      openFindings
      findingsBySeverity {
        critical
        high
        medium
        low
      }
      lastAssessment
    }
  }
`;

const COMPLIANCE_FRAMEWORKS_QUERY = `
  query ComplianceFrameworks {
    complianceFrameworks {
      id
      name
      subtitle
      compliancePercentage
      controlsMet
      controlsTotal
      controls {
        id
        controlId
        description
        status
      }
    }
  }
`;

const UPDATE_CONTROL_STATUS_MUTATION = `
  mutation UpdateControlStatus($controlId: ID!, $input: UpdateControlStatusInput!) {
    updateControlStatus(controlId: $controlId, input: $input) {
      control {
        id
        controlId
        description
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

// ---------------------------------------------------------------------------
// Status indicators
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<string, string> = {
  MET: "\u2713",
  IN_PROGRESS: "\u25CF",
  PLANNED: "\u25CF",
  NOT_MET: "\u2717",
};

// ---------------------------------------------------------------------------
// Format helpers to avoid collisions between metric card values
// ---------------------------------------------------------------------------

function formatScore(value: number): string {
  return `${value}%`;
}

function formatIntegrity(value: number): string {
  // Always show 1 decimal to distinguish from overallScore
  return `${Number(value).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Compliance() {
  const queryClient = useQueryClient();
  const [editingControl, setEditingControl] = useState<{
    id: string;
    controlId: string;
    description: string;
    currentStatus: string;
  } | null>(null);
  const [newStatus, setNewStatus] = useState("MET");
  const [reason, setReason] = useState("");
  const modalContentRef = useRef<HTMLDivElement>(null);

  // Compliance summary
  const summaryQuery = useQuery({
    queryKey: ["complianceSummary"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        COMPLIANCE_SUMMARY_QUERY,
        undefined,
        "ComplianceSummary",
        signal,
      );
      return extractField<ComplianceSummary>(raw, "complianceSummary");
    },
  });

  // Compliance frameworks
  const frameworksQuery = useQuery({
    queryKey: ["complianceFrameworks"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        COMPLIANCE_FRAMEWORKS_QUERY,
        undefined,
        "ComplianceFrameworks",
        signal,
      );
      return extractField<ComplianceFramework[]>(raw, "complianceFrameworks");
    },
  });

  // Update control status mutation
  const updateMutation = useMutation({
    mutationFn: async (vars: { controlId: string; status: string; reason: string }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        UPDATE_CONTROL_STATUS_MUTATION,
        { controlId: vars.controlId, input: { status: vars.status, reason: vars.reason } },
        "UpdateControlStatus",
      );
      return extractField<unknown>(raw, "updateControlStatus");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["complianceFrameworks"] });
      queryClient.invalidateQueries({ queryKey: ["complianceSummary"] });
      setEditingControl(null);
      setNewStatus("MET");
      setReason("");
    },
  });

  // Focus the modal content when it opens
  useEffect(() => {
    if (editingControl && modalContentRef.current) {
      modalContentRef.current.focus();
    }
  }, [editingControl]);

  const handleControlClick = useCallback(
    (control: { id: string; controlId: string; description: string; status: string }) => {
      setEditingControl({ ...control, currentStatus: control.status });
      setNewStatus(control.status === "NOT_MET" ? "IN_PROGRESS" : "MET");
      setReason("");
    },
    [],
  );

  const handleSubmitUpdate = useCallback(() => {
    if (!editingControl) return;
    updateMutation.mutate({
      controlId: editingControl.id,
      status: newStatus,
      reason,
    });
  }, [editingControl, newStatus, reason, updateMutation]);

  // ---------------------------------------------------------------------------
  // Loading / Error
  // ---------------------------------------------------------------------------

  const allLoading =
    summaryQuery.isLoading || frameworksQuery.isLoading;

  const anyError =
    summaryQuery.isError || frameworksQuery.isError;

  const errorMessage =
    summaryQuery.error?.message ||
    frameworksQuery.error?.message ||
    "Failed to load compliance data";

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------

  const summary = summaryQuery.data;
  const frameworks = frameworksQuery.data ?? [];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div aria-live="polite">
      <div className="header">
        <h2>Compliance Dashboard</h2>
        {summary?.lastAssessment && (
          <span className="text-dim">
            Last assessment: {new Date(summary.lastAssessment).toLocaleDateString()}
          </span>
        )}
      </div>

      {allLoading ? (
        <LoadingState message="Loading compliance data..." />
      ) : anyError ? (
        <ErrorState message={errorMessage} />
      ) : (
        <>
          {/* Metric cards */}
          {summary && (
            <div className="cards">
              <MetricCard
                label="Overall Score"
                value={formatScore(summary.overallScore)}
              />
              <MetricCard
                label="Capture Integrity"
                value={formatIntegrity(summary.captureIntegrity)}
              />
              <MetricCard
                label="Dropped Events"
                value={String(summary.droppedEvents)}
              />
              <MetricCard
                label="Open Findings"
                value={String(summary.openFindings)}
                subtitle={
                  summary.findingsBySeverity
                    ? `${summary.findingsBySeverity.critical}C / ${summary.findingsBySeverity.high}H / ${summary.findingsBySeverity.medium}M / ${summary.findingsBySeverity.low}L`
                    : undefined
                }
              />
            </div>
          )}

          {/* Framework cards */}
          {frameworks.length === 0 && (
            <EmptyState message="No frameworks configured yet." />
          )}
          {frameworks.map((fw) => (
            <div key={fw.id} style={{ marginBottom: "24px", padding: "16px", border: "1px solid var(--border, #333)", borderRadius: "8px" }}>
              <h3>{fw.name}</h3>
              <span className="text-dim">{fw.subtitle}</span>
              <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "8px" }}>
                <span>{fw.compliancePercentage}%</span>
                <span className="text-dim">{fw.controlsMet}/{fw.controlsTotal} controls</span>
              </div>
              <ProgressBar value={fw.compliancePercentage} />

              {/* Controls checklist */}
              <div style={{ marginTop: "12px" }}>
                {fw.controls.map((ctrl) => (
                  <div
                    key={ctrl.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "4px 0",
                      cursor: "pointer",
                    }}
                    data-status={ctrl.status}
                    onClick={() => handleControlClick(ctrl)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") handleControlClick(ctrl);
                    }}
                  >
                    <span
                      aria-label={`Status: ${ctrl.status.toLowerCase()}`}
                      style={{
                        color:
                          ctrl.status === "MET"
                            ? "var(--green, #22c55e)"
                            : ctrl.status === "NOT_MET"
                              ? "var(--red, #ef4444)"
                              : "var(--yellow, #eab308)",
                        fontWeight: "bold",
                      }}
                    >
                      {STATUS_ICON[ctrl.status] ?? "?"}
                    </span>
                    <span className="mono" style={{ fontSize: "0.85em", opacity: 0.7 }}>
                      {ctrl.controlId}
                    </span>
                    <span>{ctrl.description}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Control edit form modal */}
          {editingControl && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Update Control Status"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setEditingControl(null);
                  setReason("");
                }
              }}
              onClick={(e) => {
                if (e.target === e.currentTarget) {
                  setEditingControl(null);
                  setReason("");
                }
              }}
              style={{
                position: "fixed",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundColor: "rgba(0,0,0,0.5)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1000,
              }}
            >
              <div
                ref={modalContentRef}
                style={{
                  background: "var(--surface, #1a1a2e)",
                  padding: "24px",
                  borderRadius: "8px",
                  minWidth: "400px",
                }}
              >
                <h3>Update Control Status</h3>
                <p>
                  {editingControl.controlId}: {editingControl.description}
                </p>

                <label htmlFor="status-select" style={{ display: "block", marginTop: "12px" }}>
                  Status
                </label>
                <select
                  id="status-select"
                  value={newStatus}
                  onChange={(e) => setNewStatus(e.target.value)}
                  aria-label="Status"
                >
                  <option value="MET">MET</option>
                  <option value="IN_PROGRESS">IN_PROGRESS</option>
                  <option value="PLANNED">PLANNED</option>
                  <option value="NOT_MET">NOT_MET</option>
                </select>

                <label htmlFor="reason-input" style={{ display: "block", marginTop: "12px" }}>
                  Reason
                </label>
                <textarea
                  id="reason-input"
                  name="reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason for status change..."
                  aria-label="Reason"
                  style={{ width: "100%", minHeight: "80px", marginTop: "4px" }}
                />

                {updateMutation.isError && (
                  <p style={{ color: "var(--red, #ef4444)" }}>
                    {updateMutation.error?.message ?? "Update failed"}
                  </p>
                )}

                <div style={{ display: "flex", gap: "8px", marginTop: "16px" }}>
                  <button
                    onClick={handleSubmitUpdate}
                    disabled={reason.trim().length === 0}
                  >
                    Save
                  </button>
                  <button
                    onClick={() => {
                      setEditingControl(null);
                      setReason("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

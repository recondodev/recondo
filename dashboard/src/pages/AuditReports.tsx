import { useState, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DataTable } from "../components/DataTable";
import { TagPill } from "../components/TagPill";
import { ChartBox } from "../components/ChartBox";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { EmptyState } from "../components/EmptyState";
import { graphqlRequest, extractField } from "../graphql/client";
import { getApiToken } from "../api/client";
import type {
  ReportItem,
  ReportConnection,
  TrendDataPoint,
  FindingsBySeverity,
} from "../types/graphql";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ---------------------------------------------------------------------------
// GraphQL queries
// ---------------------------------------------------------------------------

const REPORTS_QUERY = `
  query Reports($limit: Int, $offset: Int) {
    reports(limit: $limit, offset: $offset) {
      items {
        id
        name
        framework
        periodStart
        periodEnd
        captureCount
        findings {
          critical
          high
          medium
          low
        }
        hash
        status
        generatedAt
      }
      total
      limit
      offset
    }
  }
`;

const COVERAGE_TREND_QUERY = `
  query ReportCoverageTrend {
    reportCoverageTrend {
      label
      value
    }
  }
`;

const FINDINGS_TREND_QUERY = `
  query ReportFindingsTrend {
    reportFindingsTrend {
      label
      value
    }
  }
`;

const GENERATE_REPORT_MUTATION = `
  mutation GenerateReport($input: GenerateReportInput!) {
    generateReport(input: $input) {
      report {
        id
        name
        framework
        periodStart
        periodEnd
        captureCount
        findings {
          critical
          high
          medium
          low
        }
        hash
        status
        generatedAt
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
// Report type options for generate form
// ---------------------------------------------------------------------------

const REPORT_TYPE_OPTIONS = [
  { label: "Weekly Cost", value: "WEEKLY_COST" },
  { label: "Compliance", value: "COMPLIANCE" },
  { label: "Anomaly", value: "ANOMALY" },
  { label: "Custom", value: "CUSTOM" },
];

// ---------------------------------------------------------------------------
// Status styling
// ---------------------------------------------------------------------------

const STATUS_CLASS_MAP: Record<string, string> = {
  FINAL: "tag-ok",
  DRAFT: "tag-warn",
};

const STATUS_ICON: Record<string, string> = {
  FINAL: "\u2713",
  DRAFT: "\u270E",
};

// ---------------------------------------------------------------------------
// Helper: total findings count
// ---------------------------------------------------------------------------

function totalFindings(findings: FindingsBySeverity): number {
  return findings.critical + findings.high + findings.medium + findings.low;
}

// ---------------------------------------------------------------------------
// Table columns
// ---------------------------------------------------------------------------

const columns = [
  {
    key: "name",
    header: "Name",
    render: (row: ReportItem) => row.name,
    sortable: true,
    getSortValue: (row: ReportItem) => row.name,
  },
  {
    key: "framework",
    header: "Framework",
    render: (row: ReportItem) => (
      <TagPill variant="framework" label={row.framework} />
    ),
    sortable: true,
    getSortValue: (row: ReportItem) => row.framework,
  },
  {
    key: "period",
    header: "Period",
    render: (row: ReportItem) => {
      const start = new Date(row.periodStart).toLocaleDateString();
      const end = new Date(row.periodEnd).toLocaleDateString();
      return `${start} - ${end}`;
    },
    sortable: true,
    // Sort by period start, since periods are typically same-length and the
    // start date alone gives a meaningful chronological ordering.
    getSortValue: (row: ReportItem) => row.periodStart,
  },
  {
    key: "captures",
    header: "Captures",
    render: (row: ReportItem) => row.captureCount.toLocaleString(),
    sortable: true,
    getSortValue: (row: ReportItem) => row.captureCount,
  },
  {
    key: "findings",
    header: "Findings",
    render: (row: ReportItem) => String(totalFindings(row.findings)),
    sortable: true,
    getSortValue: (row: ReportItem) => totalFindings(row.findings),
  },
  {
    key: "hash",
    header: "Hash",
    render: (row: ReportItem) => (
      <span className="mono">{row.hash ?? "--"}</span>
    ),
    sortable: true,
    getSortValue: (row: ReportItem) => row.hash ?? null,
  },
  {
    key: "status",
    header: "Status",
    render: (row: ReportItem) => (
      <span
        className={STATUS_CLASS_MAP[row.status] ?? ""}
        title={row.status}
        aria-label={`Status: ${row.status}`}
      >
        {STATUS_ICON[row.status] ?? row.status}
      </span>
    ),
    sortable: true,
    getSortValue: (row: ReportItem) => row.status,
  },
  {
    key: "download",
    header: "Download",
    render: (row: ReportItem) => (
      <DownloadButton reportId={row.id} />
    ),
    // Action column — not sortable.
  },
];

// ---------------------------------------------------------------------------
// Download button sub-component
// ---------------------------------------------------------------------------

function DownloadButton({ reportId }: { reportId: string }) {
  const encodedId = encodeURIComponent(reportId);
  const handleDownload = useCallback(async () => {
    try {
      const token = getApiToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      const response = await fetch(`/v1/reports/${encodedId}/download`, { headers });
      if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `report-${reportId}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      window.open(`/v1/reports/${encodedId}/download`);
    }
  }, [reportId, encodedId]);

  return (
    <button onClick={handleDownload} aria-label="Download">
      Download
    </button>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function AuditReports() {
  const queryClient = useQueryClient();
  const [showGenerateForm, setShowGenerateForm] = useState(false);
  const [genReportType, setGenReportType] = useState(REPORT_TYPE_OPTIONS[0].value);
  const [genStartDate, setGenStartDate] = useState("");
  const [genEndDate, setGenEndDate] = useState("");

  // Reports list
  const reportsQuery = useQuery({
    queryKey: ["reports"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        REPORTS_QUERY,
        { limit: 20, offset: 0 },
        "Reports",
        signal,
      );
      return extractField<ReportConnection>(raw, "reports");
    },
  });

  // Coverage trend
  const coverageQuery = useQuery({
    queryKey: ["reportCoverageTrend"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        COVERAGE_TREND_QUERY,
        undefined,
        "ReportCoverageTrend",
        signal,
      );
      return extractField<TrendDataPoint[]>(raw, "reportCoverageTrend");
    },
    refetchOnWindowFocus: false,
  });

  // Findings trend
  const findingsQuery = useQuery({
    queryKey: ["reportFindingsTrend"],
    queryFn: async ({ signal }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        FINDINGS_TREND_QUERY,
        undefined,
        "ReportFindingsTrend",
        signal,
      );
      return extractField<TrendDataPoint[]>(raw, "reportFindingsTrend");
    },
    refetchOnWindowFocus: false,
  });

  // Generate report mutation
  const generateMutation = useMutation({
    mutationFn: async (vars: {
      type: string;
      period: "WEEK" | "MONTH";
      from?: string;
      to?: string;
    }) => {
      const raw = await graphqlRequest<Record<string, unknown>>(
        GENERATE_REPORT_MUTATION,
        {
          input: {
            type: vars.type,
            period: vars.period,
            from: vars.from,
            to: vars.to,
          },
        },
        "GenerateReport",
      );
      return extractField<unknown>(raw, "generateReport");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      queryClient.invalidateQueries({ queryKey: ["reportCoverageTrend"] });
      queryClient.invalidateQueries({ queryKey: ["reportFindingsTrend"] });
      setShowGenerateForm(false);
      setGenStartDate("");
      setGenEndDate("");
    },
  });

  const handleGenerate = useCallback(() => {
    generateMutation.mutate({
      type: genReportType,
      period: "WEEK",
      from: genStartDate || undefined,
      to: genEndDate || undefined,
    });
  }, [generateMutation, genReportType, genStartDate, genEndDate]);

  // ---------------------------------------------------------------------------
  // Loading / Error
  // ---------------------------------------------------------------------------

  const allLoading =
    reportsQuery.isLoading || coverageQuery.isLoading || findingsQuery.isLoading;

  const anyError =
    reportsQuery.isError || coverageQuery.isError || findingsQuery.isError;

  const errorMessage =
    reportsQuery.error?.message ||
    coverageQuery.error?.message ||
    findingsQuery.error?.message ||
    "Failed to load reports data";

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------

  const reports = reportsQuery.data?.items ?? [];
  const coverageTrend = coverageQuery.data ?? [];
  const findingsTrend = findingsQuery.data ?? [];

  // Unique statuses from report data for the status legend
  const uniqueStatuses = useMemo(() => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const r of reports) {
      if (!seen.has(r.status)) {
        seen.add(r.status);
        result.push(r.status);
      }
    }
    return result;
  }, [reports]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div aria-live="polite">
      <div className="header">
        <h2>Audit Reports</h2>
        <span className="text-dim">
          Auditor-ready, tamper-evident compliance reports
        </span>
      </div>

      <div style={{ marginBottom: "12px" }}>
        <button
          onClick={() => setShowGenerateForm(true)}
          aria-label="Generate New Report"
        >
          Generate New Report
        </button>
      </div>

      {/* Generate report form */}
      {showGenerateForm && (
        <div
          style={{
            padding: "16px",
            border: "1px solid var(--border, #333)",
            borderRadius: "8px",
            marginBottom: "16px",
          }}
        >
          <h3>Generate New Report</h3>

          <label htmlFor="gen-framework" style={{ display: "block", marginTop: "8px" }}>
            Report Type
          </label>
          <select
            id="gen-framework"
            value={genReportType}
            onChange={(e) => setGenReportType(e.target.value)}
            aria-label="Report Type"
          >
            {REPORT_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>

          <label htmlFor="gen-start" style={{ display: "block", marginTop: "8px" }}>
            Start Date
          </label>
          <input
            id="gen-start"
            type="date"
            value={genStartDate}
            onChange={(e) => setGenStartDate(e.target.value)}
            aria-label="Start Date"
          />

          <label htmlFor="gen-end" style={{ display: "block", marginTop: "8px" }}>
            End Date
          </label>
          <input
            id="gen-end"
            type="date"
            value={genEndDate}
            onChange={(e) => setGenEndDate(e.target.value)}
            aria-label="End Date"
          />

          {generateMutation.isError && (
            <p style={{ color: "var(--red, #ef4444)" }}>
              {generateMutation.error?.message ?? "Generation failed"}
            </p>
          )}

          <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
            <button onClick={handleGenerate}>Submit</button>
            <button onClick={() => setShowGenerateForm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {allLoading ? (
        <LoadingState message="Loading reports data..." />
      ) : anyError ? (
        <ErrorState message={errorMessage} />
      ) : (
        <>
          {/* Status legend -- unique pills for each status */}
          {uniqueStatuses.length > 0 && (
            <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
              {uniqueStatuses.map((status) => (
                <TagPill
                  key={status}
                  variant="status"
                  label={status}
                  className={STATUS_CLASS_MAP[status] ?? ""}
                />
              ))}
            </div>
          )}

          {/* Reports table */}
          {reports.length === 0 ? (
            <EmptyState message="No reports found. Generate your first report above." />
          ) : (
            <DataTable
              columns={columns}
              data={reports}
              rowKey={(row) => row.id}
              ariaLabel="Audit reports table"
            />
          )}

          {/* Trend charts */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginTop: "24px" }}>
            <ChartBox title="Coverage Over Time">
              {coverageTrend.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={coverageTrend}>
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
                <p className="text-dim">No coverage trend data</p>
              )}
            </ChartBox>

            <ChartBox title="Issue Trend">
              {findingsTrend.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={findingsTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis dataKey="label" tick={false} />
                    <YAxis tick={false} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "var(--surface)",
                        border: "1px solid var(--border)",
                        color: "var(--text)",
                      }}
                    />
                    <Bar dataKey="value" fill="var(--red, #ef4444)" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-dim">No findings trend data</p>
              )}
            </ChartBox>
          </div>

        </>
      )}
    </div>
  );
}

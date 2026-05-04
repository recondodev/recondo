import React, { Suspense, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Sidebar } from "./components/Sidebar";
import { ErrorBoundary } from "./components/ErrorBoundary";

const RealtimeFeed = React.lazy(() => import("./pages/RealtimeFeed"));
const Sessions = React.lazy(() => import("./pages/Sessions"));
const SessionDetail = React.lazy(() => import("./pages/SessionDetail"));
const AuditTrail = React.lazy(() => import("./pages/AuditTrail"));
const Compliance = React.lazy(() => import("./pages/Compliance"));
const AuditReports = React.lazy(() => import("./pages/AuditReports"));
const CostUsage = React.lazy(() => import("./pages/CostUsage"));
const AgentAnalytics = React.lazy(() => import("./pages/AgentAnalytics"));
const Policies = React.lazy(() => import("./pages/Policies"));
const ApiKeys = React.lazy(() => import("./pages/ApiKeys"));
const NotFound = React.lazy(() => import("./pages/NotFound"));

// W4: QueryClient inside component with useState to avoid module-scope singleton
function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 2,
            staleTime: 30_000,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <Sidebar />
      <main id="main-content" className="main">
        <ErrorBoundary>
          <Suspense fallback={<div aria-label="Loading page">Loading...</div>}>
            <Routes>
              <Route path="/" element={<Navigate to="/realtime" replace />} />
              <Route path="/realtime" element={<RealtimeFeed />} />
              <Route path="/sessions" element={<Sessions />} />
              <Route path="/sessions/:id" element={<SessionDetail />} />
              <Route path="/audit" element={<AuditTrail />} />
              <Route path="/compliance" element={<Compliance />} />
              <Route path="/reports" element={<AuditReports />} />
              <Route path="/cost" element={<CostUsage />} />
              <Route path="/agents" element={<AgentAnalytics />} />
              <Route path="/policies" element={<Policies />} />
              <Route path="/keys" element={<ApiKeys />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
    </QueryClientProvider>
  );
}

export default App;

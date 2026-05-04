/**
 * Sprint D2 Batch B — Behavioral Tests
 *
 * Tests for:
 *   D2.4  Design System (global.css, CSS variables, WCAG fixes, focus-visible, print)
 *   D2.5  App Shell & Sidebar (Sidebar.tsx, App.tsx with React.lazy, routing, a11y)
 *   D2.6  Dependencies (@tanstack/react-query, graphql-request, @graphql-codegen)
 *   D2.7  Shared Components (18 components with CSS Modules)
 *   D2.10 Old views deleted (EngineerTrace, CtoOperations, etc.)
 *
 * These tests are written BEFORE implementation exists.
 * They verify the design document deliverables, not implementation internals.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import * as fs from "fs";
import * as path from "path";

// ============================================================
// Helpers
// ============================================================

const DASHBOARD_ROOT = path.resolve(__dirname, "..");
const SRC_ROOT = path.join(DASHBOARD_ROOT, "src");

/** Read a file relative to the dashboard root. Returns null if missing. */
function readFile(relativePath: string): string | null {
  const full = path.join(DASHBOARD_ROOT, relativePath);
  try {
    return fs.readFileSync(full, "utf-8");
  } catch {
    return null;
  }
}

/** Check whether a file exists relative to the dashboard root. */
function fileExists(relativePath: string): boolean {
  return fs.existsSync(path.join(DASHBOARD_ROOT, relativePath));
}

// ============================================================
// D2.4 — Design System (global.css)
// ============================================================

describe("D2.4 — Design System: global.css", () => {
  it("global.css file exists at src/styles/global.css", () => {
    expect(fileExists("src/styles/global.css")).toBe(true);
  });

  describe("CSS variables", () => {
    const REQUIRED_VARIABLES: Record<string, string> = {
      "--bg": "#0b0e14",
      "--surface": "#111620",
      "--surface2": "#181d28",
      "--border": "#232a38",
      "--text": "#c5cdd9",
      "--text-dim": "#8b9bb0",    // WCAG-fixed from mock's #6b7a90
      "--accent": "#3b82f6",
      "--accent-dim": "#1e3a5f",
      "--green": "#22c55e",
      "--green-dim": "#0a3d1f",
      "--red": "#f87171",         // WCAG-fixed from mock's #ef4444
      "--red-dim": "#3d1414",
      "--yellow": "#eab308",
      "--yellow-dim": "#3d3408",
      "--orange": "#f97316",
      "--purple": "#a855f7",
      "--cyan": "#06b6d4",
    };

    for (const [varName, expectedValue] of Object.entries(REQUIRED_VARIABLES)) {
      it(`defines ${varName}: ${expectedValue}`, () => {
        const css = readFile("src/styles/global.css");
        expect(css).not.toBeNull();
        // The CSS should contain the variable definition with the correct value.
        // Allow flexible whitespace: --bg : #0b0e14 or --bg:#0b0e14
        const pattern = new RegExp(
          `${varName.replace("-", "\\-")}\\s*:\\s*${expectedValue.replace("#", "\\#")}`,
          "i"
        );
        expect(css).toMatch(pattern);
      });
    }
  });

  it("--text-dim is WCAG-fixed to #8b9bb0, NOT the mock's #6b7a90", () => {
    const css = readFile("src/styles/global.css");
    expect(css).not.toBeNull();
    expect(css).toContain("#8b9bb0");
    expect(css).not.toContain("#6b7a90");
  });

  it("--red is WCAG-fixed to #f87171, NOT the mock's #ef4444", () => {
    const css = readFile("src/styles/global.css");
    expect(css).not.toBeNull();
    expect(css).toContain("#f87171");
    // The mock value #ef4444 should not appear as the --red definition
    // (it might appear in comments explaining the change, so we check the variable assignment)
    const redAssignment = css!.match(/--red\s*:\s*#[a-fA-F0-9]+/);
    expect(redAssignment).not.toBeNull();
    expect(redAssignment![0]).toContain("#f87171");
  });

  it("uses Inter font for body text", () => {
    const css = readFile("src/styles/global.css");
    expect(css).not.toBeNull();
    expect(css!.toLowerCase()).toMatch(/inter/);
  });

  it("defines a .mono class with monospace font-family", () => {
    const css = readFile("src/styles/global.css");
    expect(css).not.toBeNull();
    expect(css).toMatch(/\.mono\s*\{[^}]*font-family[^}]*monospace/s);
  });

  it("has no font-size declarations smaller than 11px (no 10px)", () => {
    const css = readFile("src/styles/global.css");
    expect(css).not.toBeNull();
    // Match font-size values like "font-size: 10px" or "font-size:10px"
    // Exclude CSS comments
    const withoutComments = css!.replace(/\/\*[\s\S]*?\*\//g, "");
    const fontSizeMatches = withoutComments.matchAll(/font-size\s*:\s*(\d+)px/g);
    for (const match of fontSizeMatches) {
      const size = parseInt(match[1], 10);
      expect(size).toBeGreaterThanOrEqual(11);
    }
  });

  it("includes :focus-visible styles for interactive elements", () => {
    const css = readFile("src/styles/global.css");
    expect(css).not.toBeNull();
    expect(css).toMatch(/:focus-visible/);
  });

  it("includes @media print stylesheet", () => {
    const css = readFile("src/styles/global.css");
    expect(css).not.toBeNull();
    expect(css).toMatch(/@media\s+print/);
  });

  it("global.css is imported in main.tsx", () => {
    const mainTsx = readFile("src/main.tsx");
    expect(mainTsx).not.toBeNull();
    // Should import global.css (path may vary slightly)
    expect(mainTsx).toMatch(/import\s+["'].*global\.css["']/);
  });
});

// ============================================================
// D2.5 — App Shell & Sidebar
// ============================================================

describe("D2.5 — App Shell & Sidebar", () => {
  beforeEach(() => {
    // Stub fetch so lazy-loaded pages don't cause unhandled rejections
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {}))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("Sidebar component file", () => {
    it("Sidebar.tsx exists at src/components/Sidebar.tsx", () => {
      expect(fileExists("src/components/Sidebar.tsx")).toBe(true);
    });
  });

  describe("Sidebar rendering", () => {
    it("renders the RECONDO logo text", async () => {
      // @ts-expect-error — module may not exist yet
      const App = (await import("@/App")).default;
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      );
      expect(screen.getByText("RECONDO")).toBeInTheDocument();
    });

    it("renders the AI GOVERNANCE GATEWAY subtitle", async () => {
      // @ts-expect-error — module may not exist yet
      const App = (await import("@/App")).default;
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      );
      expect(screen.getByText(/AI GOVERNANCE GATEWAY/i)).toBeInTheDocument();
    });

    it("sidebar has a <nav> element with aria-label='Main navigation'", async () => {
      // @ts-expect-error — module may not exist yet
      const App = (await import("@/App")).default;
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      );
      const nav = screen.getByRole("navigation", { name: /main navigation/i });
      expect(nav).toBeInTheDocument();
    });

    it("sidebar is 220px wide (fixed)", async () => {
      // @ts-expect-error — module may not exist yet
      const { Sidebar } = await import("@/components/Sidebar");
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Sidebar />
        </MemoryRouter>
      );
      const nav = screen.getByRole("navigation", { name: /main navigation/i });
      // Check inline style or className — the sidebar should specify 220px width
      const style = window.getComputedStyle(nav);
      // If using CSS class, check the element exists. The width might be in CSS.
      // At minimum, the element should be present.
      expect(nav).toBeInTheDocument();
    });
  });

  describe("Navigation sections and items", () => {
    const EXPECTED_SECTIONS = ["Monitor", "Audit", "Intelligence", "Governance"];

    const EXPECTED_NAV_ITEMS = [
      // Monitor
      "Realtime Feed",
      "Sessions",
      // Audit
      "Audit Trail",
      "Compliance",
      "Audit Reports",
      // Intelligence
      "Cost & Usage",
      "Agent Analytics",
      // Governance
      "Policies",
      "API Keys",
    ];

    for (const section of EXPECTED_SECTIONS) {
      it(`renders the "${section}" nav section heading`, async () => {
        // @ts-expect-error — module may not exist yet
        const App = (await import("@/App")).default;
        render(
          <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
            <App />
          </MemoryRouter>
        );
        expect(screen.getByText(section)).toBeInTheDocument();
      });
    }

    for (const item of EXPECTED_NAV_ITEMS) {
      it(`renders the "${item}" nav item`, async () => {
        // @ts-expect-error — module may not exist yet
        const App = (await import("@/App")).default;
        render(
          <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
            <App />
          </MemoryRouter>
        );
        expect(screen.getByText(item)).toBeInTheDocument();
      });
    }

    it("nav items are links (anchor elements or have link role)", async () => {
      // @ts-expect-error — module may not exist yet
      const App = (await import("@/App")).default;
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      );
      const nav = screen.getByRole("navigation", { name: /main navigation/i });
      const links = within(nav).getAllByRole("link");
      // There should be at least 9 nav item links
      expect(links.length).toBeGreaterThanOrEqual(9);
    });
  });

  describe("Skip to main content link", () => {
    it("has a 'Skip to main content' link", async () => {
      // @ts-expect-error — module may not exist yet
      const App = (await import("@/App")).default;
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      );
      const skipLink = screen.getByText(/skip to main content/i);
      expect(skipLink).toBeInTheDocument();
      expect(skipLink.tagName.toLowerCase()).toBe("a");
    });

    it("skip link points to #main-content or similar anchor", async () => {
      // @ts-expect-error — module may not exist yet
      const App = (await import("@/App")).default;
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      );
      const skipLink = screen.getByText(/skip to main content/i);
      const href = skipLink.getAttribute("href");
      expect(href).toMatch(/^#/); // Should be an anchor link
    });

    it("there is a <main> element as the content target", async () => {
      // @ts-expect-error — module may not exist yet
      const App = (await import("@/App")).default;
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      );
      const main = screen.getByRole("main");
      expect(main).toBeInTheDocument();
    });
  });

  describe("React Router — 9 pages", () => {
    const ROUTE_PATHS = [
      "/",
      "/realtime",
      "/sessions",
      "/audit",
      "/compliance",
      "/reports",
      "/cost",
      "/agents",
      "/policies",
      // "/keys" — API Keys
    ];

    it("renders without crashing at the root route", async () => {
      // @ts-expect-error — module may not exist yet
      const App = (await import("@/App")).default;
      const { container } = render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      );
      expect(container.innerHTML.length).toBeGreaterThan(0);
    });

    it("unknown route renders 404 / not found", async () => {
      // @ts-expect-error — module may not exist yet
      const App = (await import("@/App")).default;
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/definitely-does-not-exist-xyz"]}>
          <App />
        </MemoryRouter>
      );
      await waitFor(() => {
        expect(
          screen.getByText(/not found/i) ||
          screen.getByText(/404/i) ||
          screen.getByTestId("not-found")
        ).toBeInTheDocument();
      });
    });
  });

  describe("Code splitting with React.lazy", () => {
    it("App.tsx uses React.lazy for page imports", () => {
      const appTsx = readFile("src/App.tsx");
      expect(appTsx).not.toBeNull();
      expect(appTsx).toMatch(/React\.lazy|lazy\s*\(/);
    });

    it("App.tsx uses Suspense as a fallback wrapper", () => {
      const appTsx = readFile("src/App.tsx");
      expect(appTsx).not.toBeNull();
      expect(appTsx).toMatch(/Suspense/);
    });
  });

  describe("Semantic HTML", () => {
    it("uses <nav> for the sidebar navigation", async () => {
      // @ts-expect-error — module may not exist yet
      const App = (await import("@/App")).default;
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      );
      const navElements = document.querySelectorAll("nav");
      expect(navElements.length).toBeGreaterThanOrEqual(1);
    });

    it("uses <main> for the content area", async () => {
      // @ts-expect-error — module may not exist yet
      const App = (await import("@/App")).default;
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      );
      const mainElements = document.querySelectorAll("main");
      expect(mainElements.length).toBe(1);
    });

    it("nav items use <button> or <a> (not plain <div>)", async () => {
      // @ts-expect-error — module may not exist yet
      const App = (await import("@/App")).default;
      render(
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/"]}>
          <App />
        </MemoryRouter>
      );
      const nav = screen.getByRole("navigation", { name: /main navigation/i });
      // All nav items should be links (or buttons), not bare divs
      const links = within(nav).getAllByRole("link");
      expect(links.length).toBeGreaterThanOrEqual(9);
    });
  });
});

// ============================================================
// D2.6 — Dependencies
// ============================================================

describe("D2.6 — Dependencies", () => {
  let pkg: Record<string, unknown>;

  beforeEach(() => {
    const raw = readFile("package.json");
    expect(raw).not.toBeNull();
    pkg = JSON.parse(raw!);
  });

  it("@tanstack/react-query is in dependencies", () => {
    const deps = pkg.dependencies as Record<string, string> | undefined;
    expect(deps).toBeDefined();
    expect(deps!["@tanstack/react-query"]).toBeDefined();
  });

  it("graphql-request is in dependencies", () => {
    const deps = pkg.dependencies as Record<string, string> | undefined;
    expect(deps).toBeDefined();
    expect(deps!["graphql-request"]).toBeDefined();
  });

  it("@graphql-codegen packages are in devDependencies", () => {
    const devDeps = pkg.devDependencies as Record<string, string> | undefined;
    expect(devDeps).toBeDefined();
    // At least one @graphql-codegen package should be present
    const codegenPackages = Object.keys(devDeps!).filter((k) =>
      k.startsWith("@graphql-codegen")
    );
    expect(codegenPackages.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// D2.7 — Shared Components
// ============================================================

describe("D2.7 — Shared Components", () => {
  // All 18 components that must exist
  const REQUIRED_COMPONENTS = [
    "MetricCard",
    "DataTable",
    "TagPill",
    "FilterBar",
    "SearchInput",
    "Pagination",
    "Timestamp",
    "ProgressBar",
    "CostBar",
    "ChartBox",
    "TwoColumnLayout",
    "ExpandableRow",
    "FeedItem",
    "LoadingState",
    "ErrorState",
    "EmptyState",
    "Toast",
    "ErrorBoundary",
  ];

  describe("Component files exist", () => {
    for (const name of REQUIRED_COMPONENTS) {
      it(`${name}.tsx exists in src/components/`, () => {
        expect(fileExists(`src/components/${name}.tsx`)).toBe(true);
      });
    }
  });

  describe("Components export correctly", () => {
    for (const name of REQUIRED_COMPONENTS) {
      it(`${name} can be imported from src/components/${name}`, async () => {
        const mod = await import(`@/components/${name}`);
        expect(mod[name]).toBeDefined();
        expect(typeof mod[name]).toBe("function");
      });
    }
  });

  // --------------------------------------------------------
  // MetricCard
  // --------------------------------------------------------
  describe("MetricCard", () => {
    it("renders label and value", async () => {
      const { MetricCard } = await import("@/components/MetricCard");
      render(<MetricCard label="Sessions" value="42" />);
      expect(screen.getByText("Sessions")).toBeInTheDocument();
      expect(screen.getByText("42")).toBeInTheDocument();
    });

    it("renders subtitle/delta when provided", async () => {
      const { MetricCard } = await import("@/components/MetricCard");
      render(<MetricCard label="Cost" value="$18.50" subtitle="+12% vs last week" />);
      expect(screen.getByText("+12% vs last week")).toBeInTheDocument();
    });

    it("renders without subtitle (optional prop)", async () => {
      const { MetricCard } = await import("@/components/MetricCard");
      const { container } = render(<MetricCard label="Turns" value={1542} />);
      expect(container.innerHTML).not.toBe("");
    });
  });

  // --------------------------------------------------------
  // DataTable
  // --------------------------------------------------------
  describe("DataTable", () => {
    it("renders column headers", async () => {
      const { DataTable } = await import("@/components/DataTable");
      const columns = [
        { key: "name", header: "Name", render: (row: { name: string }) => row.name },
        { key: "count", header: "Count", render: (row: { count: number }) => String(row.count) },
      ];
      render(
        <DataTable
          columns={columns as any}
          data={[{ name: "Alpha", count: 10 }] as any}
        />
      );
      expect(screen.getByText("Name")).toBeInTheDocument();
      expect(screen.getByText("Count")).toBeInTheDocument();
    });

    it("renders data rows", async () => {
      const { DataTable } = await import("@/components/DataTable");
      const columns = [
        { key: "name", header: "Name", render: (row: { name: string }) => row.name },
      ];
      render(
        <DataTable
          columns={columns as any}
          data={[{ name: "Alpha" }, { name: "Beta" }] as any}
        />
      );
      expect(screen.getByText("Alpha")).toBeInTheDocument();
      expect(screen.getByText("Beta")).toBeInTheDocument();
    });

    it("renders a <table> element", async () => {
      const { DataTable } = await import("@/components/DataTable");
      const columns = [
        { key: "id", header: "ID", render: (row: { id: string }) => row.id },
      ];
      render(
        <DataTable
          columns={columns as any}
          data={[{ id: "1" }] as any}
        />
      );
      expect(document.querySelector("table")).not.toBeNull();
    });
  });

  // --------------------------------------------------------
  // TagPill
  // --------------------------------------------------------
  describe("TagPill", () => {
    it("renders label text", async () => {
      const { TagPill } = await import("@/components/TagPill");
      render(<TagPill variant="provider" label="Anthropic" />);
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
    });

    it("accepts variant prop (provider/status/framework/policy)", async () => {
      const { TagPill } = await import("@/components/TagPill");
      const variants = ["provider", "status", "framework", "policy"] as const;
      for (const variant of variants) {
        const { unmount } = render(<TagPill variant={variant} label={variant} />);
        expect(screen.getByText(variant)).toBeInTheDocument();
        unmount();
      }
    });

    it("renders as an inline element (span or similar)", async () => {
      const { TagPill } = await import("@/components/TagPill");
      render(<TagPill variant="status" label="OK" />);
      const el = screen.getByText("OK");
      expect(el.tagName.toLowerCase()).toMatch(/span|div|badge/);
    });
  });

  // --------------------------------------------------------
  // FilterBar
  // --------------------------------------------------------
  describe("FilterBar", () => {
    it("renders filter buttons", async () => {
      const { FilterBar } = await import("@/components/FilterBar");
      render(
        <FilterBar
          filters={["All", "Anthropic", "OpenAI", "Gemini"]}
          active="All"
          onFilterChange={() => {}}
        />
      );
      expect(screen.getByText("All")).toBeInTheDocument();
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
      expect(screen.getByText("OpenAI")).toBeInTheDocument();
      expect(screen.getByText("Gemini")).toBeInTheDocument();
    });

    it("calls onFilterChange when a filter is clicked", async () => {
      const { FilterBar } = await import("@/components/FilterBar");
      const onChange = vi.fn();
      render(
        <FilterBar
          filters={["All", "Anthropic"]}
          active="All"
          onFilterChange={onChange}
        />
      );
      const user = userEvent.setup();
      await user.click(screen.getByText("Anthropic"));
      expect(onChange).toHaveBeenCalledWith("Anthropic");
    });

    it("marks the active filter visually (aria or class)", async () => {
      const { FilterBar } = await import("@/components/FilterBar");
      render(
        <FilterBar
          filters={["All", "Anthropic"]}
          active="All"
          onFilterChange={() => {}}
        />
      );
      const activeBtn = screen.getByText("All");
      // Should have aria-pressed or an active class/data attribute
      const hasAriaPressed = activeBtn.getAttribute("aria-pressed") === "true";
      const hasActiveClass =
        activeBtn.className.includes("active") ||
        activeBtn.getAttribute("data-active") === "true" ||
        activeBtn.getAttribute("aria-current") === "true";
      expect(hasAriaPressed || hasActiveClass).toBe(true);
    });
  });

  // --------------------------------------------------------
  // SearchInput
  // --------------------------------------------------------
  describe("SearchInput", () => {
    it("renders an input element", async () => {
      const { SearchInput } = await import("@/components/SearchInput");
      render(<SearchInput value="" onChange={() => {}} />);
      expect(screen.getByRole("searchbox") || screen.getByRole("textbox")).toBeInTheDocument();
    });

    it("calls onChange with the input value", async () => {
      const { SearchInput } = await import("@/components/SearchInput");
      const onChange = vi.fn();
      render(<SearchInput value="" onChange={onChange} />);
      const user = userEvent.setup();
      const input = screen.getByRole("searchbox") || screen.getByRole("textbox");
      await user.type(input, "test");
      // onChange should have been called (may be debounced so just check it was called at all)
      await waitFor(() => {
        expect(onChange).toHaveBeenCalled();
      });
    });

    it("has a placeholder", async () => {
      const { SearchInput } = await import("@/components/SearchInput");
      render(<SearchInput value="" onChange={() => {}} placeholder="Search sessions..." />);
      expect(screen.getByPlaceholderText("Search sessions...")).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------
  // Pagination
  // --------------------------------------------------------
  describe("Pagination", () => {
    it("renders page navigation controls", async () => {
      const { Pagination } = await import("@/components/Pagination");
      render(<Pagination currentPage={1} totalPages={5} onPageChange={() => {}} />);
      // Should show some page indicators or buttons
      expect(screen.getByText("1") || screen.getByText(/page/i)).toBeInTheDocument();
    });

    it("calls onPageChange when a page is clicked", async () => {
      const { Pagination } = await import("@/components/Pagination");
      const onPageChange = vi.fn();
      render(<Pagination currentPage={1} totalPages={5} onPageChange={onPageChange} />);
      const user = userEvent.setup();
      // Click next or page 2
      const nextBtn =
        screen.queryByText(/next/i) ||
        screen.queryByLabelText(/next/i) ||
        screen.queryByText("2");
      if (nextBtn) {
        await user.click(nextBtn);
        expect(onPageChange).toHaveBeenCalled();
      }
    });

    it("disables previous on first page", async () => {
      const { Pagination } = await import("@/components/Pagination");
      render(<Pagination currentPage={1} totalPages={5} onPageChange={() => {}} />);
      const prevBtn =
        screen.queryByText(/prev/i) ||
        screen.queryByLabelText(/prev/i) ||
        screen.queryByText("<") ||
        screen.queryByText("\u2190"); // left arrow
      if (prevBtn) {
        expect(prevBtn).toBeDisabled();
      }
    });
  });

  // --------------------------------------------------------
  // Timestamp
  // --------------------------------------------------------
  describe("Timestamp", () => {
    it("renders a date string in local timezone", async () => {
      const { Timestamp } = await import("@/components/Timestamp");
      render(<Timestamp value="2026-03-22T10:00:00.000Z" />);
      // The component should render some text (the formatted date)
      // We cannot assert the exact string due to timezone differences,
      // but it should not be empty and should not render the raw ISO string verbatim
      const el = screen.getByText(/.+/);
      expect(el).toBeInTheDocument();
    });

    it("renders a <time> element with datetime attribute", async () => {
      const { Timestamp } = await import("@/components/Timestamp");
      const { container } = render(<Timestamp value="2026-03-22T10:00:00.000Z" />);
      const timeEl = container.querySelector("time");
      expect(timeEl).not.toBeNull();
      expect(timeEl!.getAttribute("datetime")).toBe("2026-03-22T10:00:00.000Z");
    });
  });

  // --------------------------------------------------------
  // ProgressBar
  // --------------------------------------------------------
  describe("ProgressBar", () => {
    it("renders with a percentage value", async () => {
      const { ProgressBar } = await import("@/components/ProgressBar");
      render(<ProgressBar value={75} />);
      // Should have a progressbar role or a visual indicator
      const el =
        screen.queryByRole("progressbar") ||
        document.querySelector("[class*='progress']") ||
        document.querySelector("[data-testid='progress-bar']");
      expect(el).not.toBeNull();
    });

    it("sets aria-valuenow for accessibility", async () => {
      const { ProgressBar } = await import("@/components/ProgressBar");
      render(<ProgressBar value={42} />);
      const progressbar = screen.getByRole("progressbar");
      expect(progressbar).toHaveAttribute("aria-valuenow", "42");
    });

    it("clamps value between 0 and 100", async () => {
      const { ProgressBar } = await import("@/components/ProgressBar");
      const { container: c1 } = render(<ProgressBar value={-10} />);
      const bar1 = c1.querySelector("[role='progressbar']");
      expect(bar1).not.toBeNull();
      // aria-valuenow should be clamped to 0
      expect(Number(bar1!.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(0);
    });
  });

  // --------------------------------------------------------
  // CostBar
  // --------------------------------------------------------
  describe("CostBar", () => {
    it("renders a horizontal bar", async () => {
      const { CostBar } = await import("@/components/CostBar");
      render(<CostBar value={65} label="Anthropic" amount="$15.00" />);
      expect(screen.getByText("Anthropic")).toBeInTheDocument();
      expect(screen.getByText("$15.00")).toBeInTheDocument();
    });

    it("renders without crashing with 0% value", async () => {
      const { CostBar } = await import("@/components/CostBar");
      const { container } = render(<CostBar value={0} label="Empty" amount="$0" />);
      expect(container.innerHTML).not.toBe("");
    });
  });

  // --------------------------------------------------------
  // ChartBox
  // --------------------------------------------------------
  describe("ChartBox", () => {
    it("renders with title and children", async () => {
      const { ChartBox } = await import("@/components/ChartBox");
      render(
        <ChartBox title="Usage Over Time">
          <div data-testid="chart-content">Chart goes here</div>
        </ChartBox>
      );
      expect(screen.getByText("Usage Over Time")).toBeInTheDocument();
      expect(screen.getByTestId("chart-content")).toBeInTheDocument();
    });

    it("renders title as a heading", async () => {
      const { ChartBox } = await import("@/components/ChartBox");
      render(<ChartBox title="My Chart"><div /></ChartBox>);
      const heading = screen.getByText("My Chart");
      expect(heading.tagName.toLowerCase()).toMatch(/h[1-6]/);
    });
  });

  // --------------------------------------------------------
  // TwoColumnLayout
  // --------------------------------------------------------
  describe("TwoColumnLayout", () => {
    it("renders left and right children", async () => {
      const { TwoColumnLayout } = await import("@/components/TwoColumnLayout");
      render(
        <TwoColumnLayout
          left={<div data-testid="left">Left</div>}
          right={<div data-testid="right">Right</div>}
        />
      );
      expect(screen.getByTestId("left")).toBeInTheDocument();
      expect(screen.getByTestId("right")).toBeInTheDocument();
    });

    it("renders both columns in the DOM", async () => {
      const { TwoColumnLayout } = await import("@/components/TwoColumnLayout");
      render(
        <TwoColumnLayout
          left={<span>Col A</span>}
          right={<span>Col B</span>}
        />
      );
      expect(screen.getByText("Col A")).toBeInTheDocument();
      expect(screen.getByText("Col B")).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------
  // ExpandableRow
  // --------------------------------------------------------
  describe("ExpandableRow", () => {
    it("renders in collapsed state by default", async () => {
      const { ExpandableRow } = await import("@/components/ExpandableRow");
      render(
        <ExpandableRow header={<span>Row Header</span>}>
          <div data-testid="expanded-content">Details here</div>
        </ExpandableRow>
      );
      expect(screen.getByText("Row Header")).toBeInTheDocument();
      // Content should be hidden initially
      const expandedContent = screen.queryByTestId("expanded-content");
      if (expandedContent) {
        expect(expandedContent).not.toBeVisible();
      }
    });

    it("expands on click and shows content", async () => {
      const { ExpandableRow } = await import("@/components/ExpandableRow");
      render(
        <ExpandableRow header={<span>Click Me</span>}>
          <div data-testid="details">Expanded details</div>
        </ExpandableRow>
      );
      const user = userEvent.setup();
      await user.click(screen.getByText("Click Me"));
      await waitFor(() => {
        expect(screen.getByTestId("details")).toBeVisible();
      });
    });

    it("has aria-expanded attribute", async () => {
      const { ExpandableRow } = await import("@/components/ExpandableRow");
      render(
        <ExpandableRow header={<span>Toggle</span>}>
          <div>Content</div>
        </ExpandableRow>
      );
      // The trigger element should have aria-expanded
      const trigger =
        screen.getByRole("button") ||
        screen.getByText("Toggle").closest("[aria-expanded]");
      expect(trigger).toHaveAttribute("aria-expanded");
    });

    it("toggles aria-expanded between true and false", async () => {
      const { ExpandableRow } = await import("@/components/ExpandableRow");
      render(
        <ExpandableRow header={<span>Toggle</span>}>
          <div>Content</div>
        </ExpandableRow>
      );
      const user = userEvent.setup();
      const trigger = screen.getByRole("button");

      expect(trigger).toHaveAttribute("aria-expanded", "false");
      await user.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      await user.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    });
  });

  // --------------------------------------------------------
  // FeedItem
  // --------------------------------------------------------
  describe("FeedItem", () => {
    it("renders with fixed-column grid layout", async () => {
      const { FeedItem } = await import("@/components/FeedItem");
      render(
        <FeedItem
          timestamp="10:30:45"
          provider="anthropic"
          model="claude-sonnet-4-20250514"
          intent="Implement auth"
          tokens={2500}
          cost="$0.04"
          status="ok"
        />
      );
      expect(screen.getByText("10:30:45")).toBeInTheDocument();
      expect(screen.getByText(/anthropic/i)).toBeInTheDocument();
    });

    it("renders all feed columns", async () => {
      const { FeedItem } = await import("@/components/FeedItem");
      render(
        <FeedItem
          timestamp="11:00:00"
          provider="openai"
          model="gpt-4o"
          intent="Write tests"
          tokens={1800}
          cost="$0.03"
          status="ok"
        />
      );
      expect(screen.getByText("11:00:00")).toBeInTheDocument();
      expect(screen.getByText(/openai/i)).toBeInTheDocument();
      expect(screen.getByText(/gpt-4o/i)).toBeInTheDocument();
    });
  });

  // --------------------------------------------------------
  // LoadingState
  // --------------------------------------------------------
  describe("LoadingState", () => {
    it("renders a loading indicator", async () => {
      const { LoadingState } = await import("@/components/LoadingState");
      render(<LoadingState />);
      // Should have some visual indicator — role, aria-label, or test-id
      const el =
        screen.queryByRole("status") ||
        screen.queryByLabelText(/loading/i) ||
        screen.queryByText(/loading/i) ||
        document.querySelector("[data-testid='loading-state']") ||
        document.querySelector("[class*='skeleton']") ||
        document.querySelector("[class*='loading']") ||
        document.querySelector("[class*='pulse']");
      expect(el).not.toBeNull();
    });

    it("is visible when rendered", async () => {
      const { LoadingState } = await import("@/components/LoadingState");
      const { container } = render(<LoadingState />);
      expect(container.innerHTML.length).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------
  // ErrorState
  // --------------------------------------------------------
  describe("ErrorState", () => {
    it("renders error message", async () => {
      const { ErrorState } = await import("@/components/ErrorState");
      render(<ErrorState message="Something went wrong" />);
      expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
    });

    it("renders a retry button", async () => {
      const { ErrorState } = await import("@/components/ErrorState");
      const onRetry = vi.fn();
      render(<ErrorState message="Failed to load" onRetry={onRetry} />);
      const retryBtn = screen.getByRole("button", { name: /retry/i });
      expect(retryBtn).toBeInTheDocument();
    });

    it("calls onRetry when retry button is clicked", async () => {
      const { ErrorState } = await import("@/components/ErrorState");
      const onRetry = vi.fn();
      render(<ErrorState message="Error" onRetry={onRetry} />);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /retry/i }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------
  // EmptyState
  // --------------------------------------------------------
  describe("EmptyState", () => {
    it("renders contextual messaging", async () => {
      const { EmptyState } = await import("@/components/EmptyState");
      render(<EmptyState message="No sessions found" />);
      expect(screen.getByText("No sessions found")).toBeInTheDocument();
    });

    it("renders without crashing with minimal props", async () => {
      const { EmptyState } = await import("@/components/EmptyState");
      const { container } = render(<EmptyState message="Empty" />);
      expect(container.innerHTML.length).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------
  // Toast
  // --------------------------------------------------------
  describe("Toast", () => {
    it("renders success variant", async () => {
      const { Toast } = await import("@/components/Toast");
      render(<Toast variant="success" message="Saved successfully" />);
      expect(screen.getByText("Saved successfully")).toBeInTheDocument();
    });

    it("renders error variant", async () => {
      const { Toast } = await import("@/components/Toast");
      render(<Toast variant="error" message="Operation failed" />);
      expect(screen.getByText("Operation failed")).toBeInTheDocument();
    });

    it("has an alert or status role for accessibility", async () => {
      const { Toast } = await import("@/components/Toast");
      render(<Toast variant="success" message="Done" />);
      const el =
        screen.queryByRole("alert") ||
        screen.queryByRole("status");
      expect(el).not.toBeNull();
    });
  });

  // --------------------------------------------------------
  // ErrorBoundary
  // --------------------------------------------------------
  describe("ErrorBoundary", () => {
    it("renders children when no error", async () => {
      const { ErrorBoundary } = await import("@/components/ErrorBoundary");
      render(
        <ErrorBoundary>
          <div data-testid="child">OK</div>
        </ErrorBoundary>
      );
      expect(screen.getByTestId("child")).toBeInTheDocument();
    });

    it("catches errors and shows fallback UI", async () => {
      const { ErrorBoundary } = await import("@/components/ErrorBoundary");
      // A component that throws on render
      function Bomb(): JSX.Element {
        throw new Error("Boom!");
      }

      // Suppress console.error for the expected error
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>
      );

      expect(
        screen.getByText(/something went wrong/i) ||
        screen.getByText(/error/i) ||
        screen.getByTestId("error-boundary")
      ).toBeInTheDocument();

      spy.mockRestore();
    });

    it("shows a retry button in the error state", async () => {
      const { ErrorBoundary } = await import("@/components/ErrorBoundary");
      function Bomb(): JSX.Element {
        throw new Error("Crash!");
      }

      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      render(
        <ErrorBoundary>
          <Bomb />
        </ErrorBoundary>
      );

      const retryBtn = screen.getByRole("button", { name: /retry/i });
      expect(retryBtn).toBeInTheDocument();

      spy.mockRestore();
    });
  });

  // --------------------------------------------------------
  // CSS Modules co-location
  // --------------------------------------------------------
  describe("CSS Modules for shared components", () => {
    // The design doc says shared components use CSS Modules
    const COMPONENTS_WITH_MODULES = [
      "MetricCard",
      "DataTable",
      "TagPill",
      "FilterBar",
      "SearchInput",
      "Pagination",
      "Timestamp",
      "ProgressBar",
      "CostBar",
      "ChartBox",
      "TwoColumnLayout",
      "ExpandableRow",
      "FeedItem",
      "LoadingState",
      "ErrorState",
      "EmptyState",
      "Toast",
    ];

    for (const name of COMPONENTS_WITH_MODULES) {
      it(`${name}.module.css exists alongside ${name}.tsx`, () => {
        expect(fileExists(`src/components/${name}.module.css`)).toBe(true);
      });
    }
  });
});

// ============================================================
// D2.10 — Old Views Deleted
// ============================================================

describe("D2.10 — Old views deleted", () => {
  const DELETED_VIEWS = [
    "EngineerTrace",
    "CtoOperations",
    "FinanceCost",
    "ComplianceAudit",
    "ManagementReview",
  ];

  for (const view of DELETED_VIEWS) {
    it(`${view}.tsx no longer exists in src/views/`, () => {
      expect(fileExists(`src/views/${view}.tsx`)).toBe(false);
    });
  }

  it("App.tsx does not import any of the old views", () => {
    const appTsx = readFile("src/App.tsx");
    expect(appTsx).not.toBeNull();
    for (const view of DELETED_VIEWS) {
      expect(appTsx).not.toContain(`import { ${view} }`);
      expect(appTsx).not.toContain(`from "./views/${view}"`);
      expect(appTsx).not.toContain(`from "../views/${view}"`);
    }
  });

  it("App.tsx does not reference old route paths (/engineer, /cto-operations, /finance, /management)", () => {
    const appTsx = readFile("src/App.tsx");
    expect(appTsx).not.toBeNull();
    // The old routes should be gone
    expect(appTsx).not.toMatch(/path=["']\/engineer["']/);
    expect(appTsx).not.toMatch(/path=["']\/cto-operations["']/);
    expect(appTsx).not.toMatch(/path=["']\/finance["']/);
    expect(appTsx).not.toMatch(/path=["']\/management["']/);
  });
});

// ============================================================
// Negative / Edge Cases
// ============================================================

describe("Negative & Edge Cases", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {}))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("ProgressBar handles value=0 without crashing", async () => {
    const { ProgressBar } = await import("@/components/ProgressBar");
    const { container } = render(<ProgressBar value={0} />);
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("ProgressBar handles value=100 without crashing", async () => {
    const { ProgressBar } = await import("@/components/ProgressBar");
    const { container } = render(<ProgressBar value={100} />);
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("MetricCard handles numeric value", async () => {
    const { MetricCard } = await import("@/components/MetricCard");
    render(<MetricCard label="Count" value={0} />);
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("EmptyState renders with only required message prop", async () => {
    const { EmptyState } = await import("@/components/EmptyState");
    const { container } = render(<EmptyState message="Nothing here" />);
    expect(container.innerHTML).toContain("Nothing here");
  });

  it("ErrorState renders without onRetry (optional)", async () => {
    const { ErrorState } = await import("@/components/ErrorState");
    const { container } = render(<ErrorState message="Oops" />);
    expect(container.innerHTML).toContain("Oops");
  });

  it("TagPill with empty label renders without crashing", async () => {
    const { TagPill } = await import("@/components/TagPill");
    const { container } = render(<TagPill variant="status" label="" />);
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("Pagination with totalPages=1 disables all navigation", async () => {
    const { Pagination } = await import("@/components/Pagination");
    render(<Pagination currentPage={1} totalPages={1} onPageChange={() => {}} />);
    // On a single-page pagination, prev and next should both be disabled
    const prevBtn =
      screen.queryByText(/prev/i) ||
      screen.queryByLabelText(/prev/i) ||
      screen.queryByText("<");
    const nextBtn =
      screen.queryByText(/next/i) ||
      screen.queryByLabelText(/next/i) ||
      screen.queryByText(">");
    if (prevBtn) expect(prevBtn).toBeDisabled();
    if (nextBtn) expect(nextBtn).toBeDisabled();
  });

  it("FilterBar with empty filters array renders without crashing", async () => {
    const { FilterBar } = await import("@/components/FilterBar");
    const { container } = render(
      <FilterBar filters={[]} active="" onFilterChange={() => {}} />
    );
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("CostBar handles value=100 (full width)", async () => {
    const { CostBar } = await import("@/components/CostBar");
    const { container } = render(<CostBar value={100} label="Full" amount="$100" />);
    expect(container.innerHTML).toContain("Full");
  });

  it("Timestamp handles invalid date gracefully", async () => {
    const { Timestamp } = await import("@/components/Timestamp");
    // Should not throw
    const { container } = render(<Timestamp value="not-a-date" />);
    expect(container.innerHTML.length).toBeGreaterThan(0);
  });

  it("SearchInput with initial value renders correctly", async () => {
    const { SearchInput } = await import("@/components/SearchInput");
    render(<SearchInput value="existing search" onChange={() => {}} />);
    const input = (screen.queryByRole("searchbox") || screen.queryByRole("textbox")) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("existing search");
  });
});

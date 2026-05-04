import { Link, useLocation } from "react-router-dom";

interface NavItem {
  label: string;
  path: string;
  dotColor: string;
}

interface NavSection {
  heading: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    heading: "Monitor",
    items: [
      { label: "Realtime Feed", path: "/realtime", dotColor: "var(--green)" },
      { label: "Sessions", path: "/sessions", dotColor: "var(--accent)" },
    ],
  },
  {
    heading: "Audit",
    items: [
      { label: "Audit Trail", path: "/audit", dotColor: "var(--purple)" },
      { label: "Compliance", path: "/compliance", dotColor: "var(--cyan)" },
      { label: "Audit Reports", path: "/reports", dotColor: "var(--orange)" },
    ],
  },
  {
    heading: "Intelligence",
    items: [
      { label: "Cost & Usage", path: "/cost", dotColor: "var(--yellow)" },
      { label: "Agent Analytics", path: "/agents", dotColor: "var(--green)" },
    ],
  },
  {
    heading: "Governance",
    items: [
      { label: "Policies", path: "/policies", dotColor: "var(--cyan)" },
      { label: "API Keys", path: "/keys", dotColor: "var(--text-dim)" },
    ],
  },
];

export function Sidebar() {
  const location = useLocation();

  return (
    <nav className="sidebar" aria-label="Main navigation">
      <div className="logo">
        <h1>RECONDO</h1>
        <div className="tag">AI GOVERNANCE GATEWAY</div>
      </div>

      {NAV_SECTIONS.map((section) => (
        <div key={section.heading}>
          <div className="nav-section">{section.heading}</div>
          {section.items.map((item) => {
            const isActive =
              location.pathname === item.path ||
              (item.path === "/realtime" && location.pathname === "/");
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`nav-item${isActive ? " active" : ""}`}
              >
                <div
                  className="dot"
                  style={{ background: item.dotColor }}
                />
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

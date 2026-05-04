export const ALL_SESSION_FILTERS = [
  "All Sessions",
  "Active",
  "Completed",
  "Claude Code",
  "Cursor",
  "Codex",
  "Aider",
];

export const SESSION_FRAMEWORK_MAP: Record<string, string> = {
  "Claude Code": "claude-code",
  Cursor: "cursor",
  Codex: "codex",
  Aider: "aider",
};

export function normalizeSessionFilter(value: string | null | undefined): string {
  if (!value) return "All Sessions";
  return ALL_SESSION_FILTERS.includes(value) ? value : "All Sessions";
}

export function buildSessionSearchParams(options: {
  filter?: string | null;
  search?: string | null;
  showNonLlm?: boolean;
}): URLSearchParams {
  const params = new URLSearchParams();
  const filter = normalizeSessionFilter(options.filter);
  const search = options.search ?? "";

  if (filter !== "All Sessions") {
    params.set("filter", filter);
  }

  if (search.trim()) {
    params.set("search", search);
  }

  if (options.showNonLlm) {
    params.set("showNonLlm", "1");
  }

  return params;
}

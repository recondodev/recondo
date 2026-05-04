import styles from "./TagPill.module.css";

type TagVariant = "provider" | "status" | "framework" | "policy";

function getProviderClass(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes("anthropic")) return styles.providerAnthropic;
  if (lower.includes("openai")) return styles.providerOpenai;
  if (lower.includes("gemini") || lower.includes("google")) return styles.providerGemini;
  return styles.provider;
}

function getStatusClass(label: string): string {
  const lower = label.toLowerCase();
  const code = parseInt(label, 10);
  if (!isNaN(code) && code >= 200 && code < 400) return styles.statusOk;
  if (!isNaN(code) && code >= 400) return styles.statusError;
  if (lower === "gateway live" || lower === "live" || lower === "active" || lower === "complete") return styles.statusOk;
  if (lower === "incomplete") return styles.statusError;
  if (lower === "preflight") return styles.statusPreflight;
  if (lower === "completed") return styles.statusCompleted;
  if (lower === "offline") return styles.statusError;
  return styles.status;
}

function getFrameworkClass(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes("claude")) return styles.frameworkClaudeCode;
  if (lower.includes("codex")) return styles.frameworkCodex;
  if (lower.includes("cursor")) return styles.frameworkCursor;
  if (lower.includes("aider")) return styles.frameworkAider;
  return styles.framework;
}

interface TagPillProps {
  variant: TagVariant;
  label: string;
  className?: string;
}

export function TagPill({ variant, label, className }: TagPillProps) {
  let variantClass: string;
  if (variant === "provider") {
    variantClass = getProviderClass(label);
  } else if (variant === "status") {
    variantClass = getStatusClass(label);
  } else if (variant === "framework") {
    variantClass = getFrameworkClass(label);
  } else {
    variantClass = styles.policy;
  }

  const classes = [styles.pill, variantClass, className]
    .filter(Boolean)
    .join(" ");
  return (
    <span className={classes}>{label}</span>
  );
}

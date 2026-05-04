import styles from "./MetricCard.module.css";

interface MetricCardProps {
  label: string;
  value: string | number;
  subtitle?: string;
  delta?: { value: string; direction: "up" | "down"; showArrow?: boolean };
}

export function MetricCard({ label, value, subtitle, delta }: MetricCardProps) {
  return (
    <div className={styles.card}>
      <div className={styles.label}>{label}</div>
      <div className={styles.value}>{String(value)}</div>
      {subtitle && <div className={styles.subtitle}>{subtitle}</div>}
      {delta && (
        <div
          className={styles.delta}
          style={{ color: delta.direction === "up" ? "var(--green)" : "var(--red)" }}
        >
          {delta.showArrow === false
            ? delta.value
            : `${delta.direction === "up" ? "\u2191" : "\u2193"} ${delta.value}`}
        </div>
      )}
    </div>
  );
}

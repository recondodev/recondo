import styles from "./CostBar.module.css";

interface CostBarProps {
  value: number;
  label: string;
  amount: string;
  color?: string;
  valueLabel?: string;
}

export function CostBar({ value, label, amount, color, valueLabel }: CostBarProps) {
  const clamped = Math.max(0, Math.min(100, value));

  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <div
        className={styles.barWrap}
        role="meter"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} cost`}
      >
        <div
          className={styles.fill}
          style={{
            width: `${clamped}%`,
            background: color || "var(--accent)",
          }}
        >
          {valueLabel && clamped >= 6 ? (
            <span className={styles.valueLabel}>{valueLabel}</span>
          ) : null}
        </div>
      </div>
      <span className={styles.amount}>{amount}</span>
    </div>
  );
}

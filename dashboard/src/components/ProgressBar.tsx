import styles from "./ProgressBar.module.css";

interface ProgressBarProps {
  value: number;
  color?: string;
}

export function ProgressBar({ value, color }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, value));

  return (
    <div
      className={styles.bar}
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={styles.fill}
        style={{
          width: `${clamped}%`,
          background: color || "var(--accent)",
        }}
      />
    </div>
  );
}

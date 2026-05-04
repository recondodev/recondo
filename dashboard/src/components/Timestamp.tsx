import styles from "./Timestamp.module.css";

interface TimestampProps {
  value: string;
}

export function Timestamp({ value }: TimestampProps) {
  const date = new Date(value);
  const isValid = !isNaN(date.getTime());
  const formatted = isValid
    ? date.toLocaleString()
    : "Invalid date";

  return (
    <time
      className={styles.timestamp}
      dateTime={isValid ? date.toISOString() : undefined}
    >
      {formatted}
    </time>
  );
}

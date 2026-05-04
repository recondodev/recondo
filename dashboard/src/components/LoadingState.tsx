import styles from "./LoadingState.module.css";

interface LoadingStateProps {
  message?: string;
}

export function LoadingState({ message }: LoadingStateProps) {
  return (
    <div
      className={styles.loading}
      role="status"
      aria-label="Loading"
      data-testid="loading-state"
    >
      <div className={styles.spinner} />
      <span>{message || "Loading..."}</span>
    </div>
  );
}

import styles from "./Toast.module.css";

type ToastVariant = "success" | "error" | "warning" | "info";

interface ToastProps {
  variant: ToastVariant;
  message: string;
  onDismiss?: () => void;
}

export function Toast({ variant, message, onDismiss }: ToastProps) {
  const role = variant === "error" || variant === "warning" ? "alert" : "status";

  return (
    <div
      className={`${styles.toast} ${styles[variant]}`}
      role={role}
    >
      <span className={styles.message}>{message}</span>
      {onDismiss && (
        <button
          className={styles.dismiss}
          onClick={onDismiss}
          aria-label="Dismiss notification"
        >
          &times;
        </button>
      )}
    </div>
  );
}

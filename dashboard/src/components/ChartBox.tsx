import type { ReactNode } from "react";
import styles from "./ChartBox.module.css";

interface ChartBoxProps {
  title: string;
  children: ReactNode;
}

export function ChartBox({ title, children }: ChartBoxProps) {
  return (
    <div className={styles.box}>
      <h3 className={styles.title}>{title}</h3>
      {children}
    </div>
  );
}

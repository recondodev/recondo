// Single-select by design for v1. Multi-select deferred.
import styles from "./FilterBar.module.css";

interface FilterBarProps {
  filters: string[];
  active: string;
  onFilterChange: (filter: string) => void;
  compact?: boolean;
}

export function FilterBar({
  filters,
  active,
  onFilterChange,
  compact = false,
}: FilterBarProps) {
  return (
    <div
      className={`${styles.filters} ${compact ? styles.compact : ""}`}
      role="group"
      aria-label="Filters"
    >
      {filters.map((filter) => (
        <button
          key={filter}
          className={`${styles.btn} ${filter === active ? styles.active : ""}`}
          aria-pressed={filter === active}
          onClick={() => onFilterChange(filter)}
        >
          {filter}
        </button>
      ))}
    </div>
  );
}

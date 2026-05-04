import { useMemo, useState, type ReactNode } from "react";
import styles from "./DataTable.module.css";

type SortValue = string | number | null;

interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Mark the column header as a sort toggle. Requires `getSortValue`. */
  sortable?: boolean;
  /** Returns the value to sort by; numbers compared numerically, strings
   * case-insensitively. Returning null sinks the row to the bottom regardless
   * of direction (consistent "missing data" placement). */
  getSortValue?: (row: T) => SortValue;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  rowKey?: (row: T) => string | number;
  onRowClick?: (row: T, index: number) => void;
  rowClassName?: (row: T) => string | undefined;
  ariaLabel?: string;
}

type SortDir = "asc" | "desc";

export function DataTable<T>({
  columns,
  data,
  rowKey,
  onRowClick,
  rowClassName,
  ariaLabel,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const handleHeaderClick = (col: Column<T>) => {
    if (!col.sortable || !col.getSortValue) return;
    if (sortKey === col.key) {
      setSortDir((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(col.key);
      setSortDir("asc");
    }
  };

  const sortedData = useMemo(() => {
    if (!sortKey) return data;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.getSortValue) return data;
    const getValue = col.getSortValue;
    const dirMul = sortDir === "asc" ? 1 : -1;
    // Stable sort: pair with original index so ties preserve input order.
    return data
      .map((row, idx) => ({ row, idx, v: getValue(row) }))
      .sort((a, b) => {
        // Nulls always sink to the bottom.
        if (a.v === null && b.v === null) return a.idx - b.idx;
        if (a.v === null) return 1;
        if (b.v === null) return -1;
        if (typeof a.v === "number" && typeof b.v === "number") {
          return (a.v - b.v) * dirMul || a.idx - b.idx;
        }
        const cmp = String(a.v).localeCompare(String(b.v), undefined, {
          numeric: true,
          sensitivity: "base",
        });
        return cmp * dirMul || a.idx - b.idx;
      })
      .map((entry) => entry.row);
  }, [data, columns, sortKey, sortDir]);

  return (
    <div className={styles.wrap}>
      <table aria-label={ariaLabel}>
        <thead>
          <tr>
            {columns.map((col) => {
              const isActive = col.sortable && sortKey === col.key;
              const indicator = !col.sortable
                ? null
                : isActive
                ? sortDir === "asc"
                  ? " ▲"
                  : " ▼"
                : " ⇅";
              return (
                <th
                  key={col.key}
                  aria-sort={
                    isActive
                      ? sortDir === "asc"
                        ? "ascending"
                        : "descending"
                      : col.sortable
                      ? "none"
                      : undefined
                  }
                  onClick={col.sortable ? () => handleHeaderClick(col) : undefined}
                  style={col.sortable ? { cursor: "pointer", userSelect: "none" } : undefined}
                  tabIndex={col.sortable ? 0 : undefined}
                  onKeyDown={
                    col.sortable
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            handleHeaderClick(col);
                          }
                        }
                      : undefined
                  }
                >
                  {col.header}
                  {indicator && (
                    <span aria-hidden="true" style={{ opacity: isActive ? 1 : 0.4 }}>
                      {indicator}
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedData.map((row, rowIdx) => (
            <tr
              key={rowKey ? rowKey(row) : rowIdx}
              onClick={() => onRowClick?.(row, rowIdx)}
              className={[onRowClick ? styles.clickable : "", rowClassName?.(row) ?? ""].filter(Boolean).join(" ") || undefined}
              style={onRowClick ? { cursor: "pointer" } : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        onRowClick(row, rowIdx);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((col) => (
                <td key={col.key}>{col.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

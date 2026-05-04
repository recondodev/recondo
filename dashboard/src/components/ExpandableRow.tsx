import { useState, useId } from "react";
import type { ReactNode } from "react";
import styles from "./ExpandableRow.module.css";

interface ExpandableRowProps {
  header: ReactNode;
  children: ReactNode;
  /** Controlled expanded state. When provided, the component is controlled. */
  expanded?: boolean;
  /** Callback when the user toggles expansion (used in controlled mode). */
  onToggle?: () => void;
  /** Optional class applied to the outer row wrapper. */
  className?: string;
  /** Optional class applied to the trigger element. */
  triggerClassName?: string;
  /** Optional class applied to the content container. */
  contentClassName?: string;
  /**
   * When "div", renders the trigger as a styled div instead of a native
   * button.  The div carries aria-expanded so assistive technology can
   * announce the expanded/collapsed state.  It deliberately omits
   * role="button" to avoid clashing with a co-located native button
   * trigger when multiple ExpandableRows appear in the same list.
   */
  triggerAs?: "button" | "div";
}

export function ExpandableRow({
  header,
  children,
  expanded: controlledExpanded,
  onToggle,
  className,
  triggerClassName,
  contentClassName,
  triggerAs = "button",
}: ExpandableRowProps) {
  const [internalExpanded, setInternalExpanded] = useState(false);
  // N2: generate a stable ID for aria-controls
  const contentId = useId();

  const isControlled = controlledExpanded !== undefined;
  const expanded = isControlled ? controlledExpanded : internalExpanded;

  const handleToggle = () => {
    if (isControlled) {
      onToggle?.();
    } else {
      setInternalExpanded((prev) => !prev);
    }
  };

  return (
    <div className={[styles.row, className].filter(Boolean).join(" ")}>
      {triggerAs === "button" ? (
        <button
          className={[styles.trigger, triggerClassName].filter(Boolean).join(" ")}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={handleToggle}
        >
          {header}
        </button>
      ) : (
        <div
          className={[styles.trigger, triggerClassName].filter(Boolean).join(" ")}
          tabIndex={0}
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={handleToggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleToggle();
            }
          }}
          style={{ cursor: "pointer" }}
        >
          {header}
        </div>
      )}
      {expanded && (
        <div
          id={contentId}
          className={[styles.content, contentClassName].filter(Boolean).join(" ")}
        >
          {children}
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import type { ToolCallEntry } from "../types";

const STATUS_LABEL: Record<string, string> = {
  pending: "pending",
  in_progress: "running",
  completed: "done",
  failed: "failed",
};

type Props = {
  tool: ToolCallEntry;
};

export function ToolCallCard({ tool }: Props) {
  const [expanded, setExpanded] = useState(tool.expanded);

  return (
    <div className={`tool-call status-${tool.status}`}>
      <button
        type="button"
        className="tool-call-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="tool-status-dot" aria-hidden />
        <span className="tool-title">{tool.title}</span>
        <span className="tool-status">
          {STATUS_LABEL[tool.status] ?? tool.status}
        </span>
        <span className="tool-chevron">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && tool.summary && (
        <pre className="tool-summary">{tool.summary}</pre>
      )}
    </div>
  );
}

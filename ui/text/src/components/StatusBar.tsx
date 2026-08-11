import React, { useMemo } from "react";
import { Box, Text } from "ink";
import { Rule } from "./Rule.js";
import { Spinner } from "./Spinner.js";
import {
  CRANBERRY,
  TEAL,
  GOLD,
  TEXT_DIM,
  RULE_COLOR,
} from "../colors.js";
import {
  contextUsagePercent,
  formatTokenCount,
  isErrorStatus,
} from "../utils.js";

export interface ContextUsage {
  used: number;
  size: number;
}

interface StatusBarProps {
  width: number;
  status: string;
  loading: boolean;
  spinIdx: number;
  contextUsage: ContextUsage | null;
}

function contextColor(percent: number): string {
  if (percent > 90) return CRANBERRY;
  if (percent > 75) return GOLD;
  return TEAL;
}

function renderProgressBar(percent: number, barWidth: number): string {
  const filled = Math.round((percent / 100) * barWidth);
  const empty = Math.max(barWidth - filled, 0);
  return "█".repeat(filled) + "░".repeat(empty);
}

export const StatusBar = React.memo(function StatusBar({
  width,
  status,
  loading,
  spinIdx,
  contextUsage,
}: StatusBarProps) {
  const constrainedWidth = Math.max(width, 20);

  const statusColor =
    status === "ready" ? TEAL : isErrorStatus(status) ? CRANBERRY : TEXT_DIM;

  const layout = useMemo(() => {
    const hasContext =
      contextUsage !== null &&
      contextUsage.size > 0 &&
      Number.isFinite(contextUsage.used);

    if (!hasContext) {
      return {
        percent: null as number | null,
        tokens: null as string | null,
        bar: null as string | null,
        rightWidth: 0,
        leftWidth: constrainedWidth,
      };
    }

    const percent = contextUsagePercent(contextUsage.used, contextUsage.size);
    const tokens = `${formatTokenCount(contextUsage.used)} / ${formatTokenCount(contextUsage.size)}`;
    const pctSuffix = ` · ${percent}%`;
    // Keep at least 8 cols for status; progress bar only when wide enough.
    const minLeft = 8;
    const showBar = constrainedWidth >= 56;
    const barWidth = 8;
    const fullRight =
      (showBar ? barWidth + 1 : 0) + tokens.length + pctSuffix.length;
    const rightWidth = Math.min(fullRight, constrainedWidth - minLeft);
    // Drop the bar first if the right side must shrink.
    const bar =
      showBar && rightWidth >= barWidth + 1 + tokens.length + pctSuffix.length
        ? renderProgressBar(percent, barWidth)
        : null;
    const leftWidth = constrainedWidth - rightWidth;

    return { percent, tokens, bar, rightWidth, leftWidth };
  }, [contextUsage, constrainedWidth]);

  const spinnerSlots = loading ? 2 : 0; // spinner glyph + space
  const statusMax = Math.max(layout.leftWidth - spinnerSlots, 1);
  const statusText =
    status.length > statusMax
      ? `${status.slice(0, Math.max(statusMax - 1, 1))}…`
      : status;

  return (
    <Box flexDirection="column" width={constrainedWidth} flexShrink={0}>
      <Rule width={constrainedWidth} />
      <Box width={constrainedWidth} height={1}>
        <Box width={layout.leftWidth} height={1}>
          {loading && (
            <>
              <Spinner idx={spinIdx} />
              <Text> </Text>
            </>
          )}
          <Text color={statusColor}>{statusText}</Text>
        </Box>
        {layout.tokens !== null && layout.percent !== null && (
          <Box width={layout.rightWidth} height={1} justifyContent="flex-end">
            {layout.bar !== null && (
              <Text color={RULE_COLOR}>{layout.bar} </Text>
            )}
            <Text color={contextColor(layout.percent)}>{layout.tokens}</Text>
            <Text color={TEXT_DIM}> · {layout.percent}%</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
});

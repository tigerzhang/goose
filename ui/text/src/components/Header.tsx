import React from "react";
import { Box, Text } from "ink";
import { Rule } from "./Rule.js";
import { TEXT_PRIMARY, TEXT_DIM, RULE_COLOR } from "../colors.js";

interface HeaderProps {
  width: number;
  turnInfo?: { current: number; total: number };
}

export const Header = React.memo(function Header({
  width,
  turnInfo,
}: HeaderProps) {
  const constrainedWidth = Math.max(width, 20);
  const leftSideWidth = Math.min(
    Math.floor(constrainedWidth * 0.3),
    constrainedWidth - 15,
  );
  const rightSideWidth = constrainedWidth - leftSideWidth;

  return (
    <Box flexDirection="column" width={constrainedWidth} flexShrink={0}>
      <Box justifyContent="space-between" width={constrainedWidth}>
        <Box width={leftSideWidth}>
          <Text color={TEXT_PRIMARY} bold>
            goose
          </Text>
          {turnInfo && turnInfo.total > 1 && (
            <>
              <Text color={RULE_COLOR}> · </Text>
              <Text color={TEXT_DIM}>
                {turnInfo.current}/{turnInfo.total}
              </Text>
            </>
          )}
        </Box>
        <Box width={rightSideWidth} justifyContent="flex-end">
          <Text color={TEXT_DIM}>^E exts · ^M models · ^P providers</Text>
        </Box>
      </Box>
      <Rule width={constrainedWidth} />
    </Box>
  );
});

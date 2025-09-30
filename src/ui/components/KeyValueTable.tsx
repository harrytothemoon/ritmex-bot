import React from "react";
import { Box, Text } from "ink";

interface KeyValueRow {
  label: string;
  value: string;
  color?: string;
}

interface KeyValueTableProps {
  data: KeyValueRow[];
}

export function KeyValueTable({ data }: KeyValueTableProps) {
  // 计算最长的 label 宽度
  const maxLabelWidth = data.reduce(
    (max, row) => Math.max(max, row.label.length),
    0
  );

  return (
    <Box flexDirection="column">
      {data.map((row, index) => (
        <Box key={index}>
          <Text dimColor>{row.label.padEnd(maxLabelWidth + 2)}</Text>
          <Text color={row.color as any}>{row.value}</Text>
        </Box>
      ))}
    </Box>
  );
}

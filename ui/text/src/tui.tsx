#!/usr/bin/env node
import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { MultilineInput } from "ink-multiline-input";
import meow from "meow";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import type {
  SessionNotification,
  Stream,
  ContentChunk,
  ToolCall,
  ToolCallUpdate,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION, ndJsonStream } from "@agentclientprotocol/sdk";
import { GooseClient } from "@aaif/goose-sdk";
import { resolveGooseBinary } from "@aaif/goose-sdk/node";
import Onboarding from "./onboarding.js";
import ConfigureScreen, { ConfigureIntent } from "./configure.js";
import ExtensionsManager from "./extensions.js";
import { DiffViewer } from "./components/DiffViewer.js";
import type { Turn } from "./types.js";
import {
  emptyLine,
  renderUserPrompt,
  renderToolCallItem,
  renderErrorItem,
  renderContentItem,
  renderLoadingIndicator,
  renderQueuedMessages,
} from "./components/ContentRenderers.js";
import { Header } from "./components/Header.js";
import { Rule } from "./components/Rule.js";
import {
  StatusBar,
  type ContextUsage,
} from "./components/StatusBar.js";
import { ToolCallExpanded } from "./components/ToolCallExpanded.js";
import type { ToolCallInfo } from "./toolcall.js";
import { isErrorStatus, formatError } from "./utils.js";
import {
  CRANBERRY,
  TEAL,
  GOLD,
  TEXT_PRIMARY,
  TEXT_DIM,
  RULE_COLOR,
} from "./colors.js";
import { Spinner, SPINNER_FRAMES } from "./components/Spinner.js";
import {
  PASTE_THRESHOLD,
  INPUT_MAX_ROWS,
  SENT_PREVIEW_LEN,
  GOOSE_FRAMES,
  INITIAL_GREETING,
  SCROLL_STEP,
  SCROLL_FAST_MULTIPLIER,
  CTRL_D_EXIT_MS,
} from "./constants.js";
import {
  tryRunSlashCommand,
  matchSlashCommands,
  STARTUP_GUIDE_COMMANDS,
  STARTUP_GUIDE_KEYS,
  SLASH_AUTOCOMPLETE_MAX,
  type SlashSuggestion,
} from "./slashCommands.js";

function parseAcpUsageUpdate(
  update: SessionNotification["update"],
): ContextUsage | null {
  if (update.sessionUpdate !== "usage_update") return null;
  const u = update as {
    sessionUpdate: "usage_update";
    used?: unknown;
    size?: unknown;
  };
  if (typeof u.used !== "number" || typeof u.size !== "number") return null;
  if (!Number.isFinite(u.used) || !Number.isFinite(u.size) || u.size <= 0) {
    return null;
  }
  return { used: u.used, size: u.size };
}

const InputBar = React.memo(function InputBar({
  width,
  input,
  onChange,
  onSubmit,
  queued,
  scrollHint,
  placeholder,
  focused,
  pastedFull,
  onPastedFullChange,
  suggestions,
  selectedSuggestion,
  onSelectSuggestion,
  onTabSuggestion,
  /** Bump to remount the text input so the cursor jumps to the end. */
  inputCursorKey = 0,
}: {
  width: number;
  input: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  queued: boolean;
  scrollHint: boolean;
  placeholder?: string;
  focused: boolean;
  pastedFull: string | null;
  onPastedFullChange: (v: string | null) => void;
  suggestions: SlashSuggestion[];
  selectedSuggestion: number;
  onSelectSuggestion: (index: number) => void;
  /** Tab / Shift+Tab: cycle or complete the current slash suggestion. */
  onTabSuggestion: (shift: boolean) => void;
  inputCursorKey?: number;
}) {
  const prevLenRef = useRef(input.length);
  const hasSuggestions = suggestions.length > 0;
  const visibleSuggestions = suggestions.slice(0, SLASH_AUTOCOMPLETE_MAX);

  const handleChange = useCallback(
    (newValue: string) => {
      const delta = newValue.length - prevLenRef.current;
      prevLenRef.current = newValue.length;
      if (delta >= PASTE_THRESHOLD) {
        onPastedFullChange(newValue);
        onChange(newValue);
      } else {
        if (pastedFull !== null) onPastedFullChange(null);
        onChange(newValue);
      }
    },
    [onChange, pastedFull, onPastedFullChange],
  );

  const handleSubmit = useCallback(
    (value: string) => {
      prevLenRef.current = 0;
      onPastedFullChange(null);
      onSubmit(value);
    },
    [onSubmit, onPastedFullChange],
  );

  // Paste-mode keyboard handling
  useInput(
    (ch, key) => {
      if (key.return) {
        handleSubmit(input);
        return;
      }
      if (key.backspace || key.delete) {
        prevLenRef.current = 0;
        onPastedFullChange(null);
        onChange("");
        return;
      }
      if (key.escape) {
        prevLenRef.current = 0;
        onPastedFullChange(null);
        onChange("");
        return;
      }
      if (ch && !key.ctrl && !key.meta) {
        prevLenRef.current = ch.length;
        onPastedFullChange(null);
        onChange(ch);
      }
    },
    { isActive: focused && pastedFull !== null },
  );

  // Slash-command autocomplete keys (Tab / arrows) when suggestions are open.
  // Enter always submits the current text — Tab cycles/completes.
  useInput(
    (_ch, key) => {
      if (!hasSuggestions) return;

      if (key.tab) {
        onTabSuggestion(Boolean(key.shift));
        return;
      }
      if (key.upArrow && !key.shift && !key.meta) {
        onSelectSuggestion(
          selectedSuggestion <= 0
            ? visibleSuggestions.length - 1
            : selectedSuggestion - 1,
        );
        return;
      }
      if (key.downArrow && !key.shift && !key.meta) {
        onSelectSuggestion(
          (selectedSuggestion + 1) % visibleSuggestions.length,
        );
        return;
      }
    },
    { isActive: focused && pastedFull === null && hasSuggestions },
  );

  const isPasteMode = pastedFull !== null;
  const constrainedWidth = Math.max(width, 20);
  const contentWidth = Math.max(constrainedWidth - 6, 10);
  const cmdColWidth = Math.min(14, Math.max(contentWidth - 8, 8));
  const descColWidth = Math.max(contentWidth - cmdColWidth - 2, 8);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={RULE_COLOR}
      paddingX={1}
      marginTop={1}
      width={constrainedWidth}
      flexShrink={0}
    >
      <Box>
        <Text color={CRANBERRY} bold>
          {"❯ "}
        </Text>
        {isPasteMode ? (
          <Box width={contentWidth} justifyContent="space-between">
            <Box width={Math.max(contentWidth - 20, 10)}>
              <Text color={TEXT_PRIMARY} wrap="truncate-end">
                {(() => {
                  const text = pastedFull;
                  const availableWidth = Math.max(contentWidth - 20, 10);
                  const flat = text
                    .replace(/\n/g, " ")
                    .replace(/\s+/g, " ")
                    .trim();
                  if (flat.length <= availableWidth) return flat;
                  const suffix = ` (${flat.length.toLocaleString()} chars)`;
                  const previewLen = Math.max(
                    availableWidth - suffix.length - 1,
                    5,
                  );
                  return flat.slice(0, previewLen) + "…" + suffix;
                })()}
              </Text>
            </Box>
            {scrollHint && (
              <Text color={TEXT_DIM}>
                ↑↓ scroll · ⌥↑↓ fast · shift+↑↓ history
              </Text>
            )}
          </Box>
        ) : (
          <Box flexGrow={1} justifyContent="space-between">
            <MultilineInput
              // Remount after programmatic completion so cursor starts at end.
              // ink-multiline-input only clamps cursor when value shrinks, so
              // external setValue leaves the caret mid-string otherwise.
              key={inputCursorKey}
              value={input}
              onChange={handleChange}
              onSubmit={handleSubmit}
              rows={1}
              maxRows={INPUT_MAX_ROWS}
              placeholder={placeholder}
              focus={focused}
              keyBindings={{
                submit: (key) => key.return && !key.ctrl,
                newline: (key) => key.return && key.ctrl,
              }}
              useCustomInput={(handler, isActive) => {
                useInput(
                  (ch, key) => {
                    if (key.shift && (key.upArrow || key.downArrow)) return;
                    // Ctrl+letter is reserved for app shortcuts (e.g. double
                    // Ctrl+D exit). Still allow Ctrl+Enter for newline.
                    if (key.ctrl && !key.return) return;
                    // Autocomplete owns Tab and ↑↓ while the popup is open.
                    if (hasSuggestions) {
                      if (key.tab || ch === "\t") return;
                      if (
                        (key.upArrow || key.downArrow) &&
                        !key.shift &&
                        !key.meta
                      ) {
                        return;
                      }
                    }
                    handler(ch, key);
                  },
                  { isActive },
                );
              }}
            />
            {scrollHint && !hasSuggestions && (
              <Text color={TEXT_DIM}>
                ↑↓ scroll · ⌥↑↓ fast · shift+↑↓ history
              </Text>
            )}
          </Box>
        )}
      </Box>
      {hasSuggestions && !isPasteMode && (
        <Box flexDirection="column" width={contentWidth}>
          {visibleSuggestions.map((s, i) => {
            const selected = i === selectedSuggestion;
            return (
              <Box key={s.name} height={1} width={contentWidth}>
                <Box width={cmdColWidth}>
                  <Text color={selected ? TEAL : TEXT_DIM} bold={selected}>
                    {selected ? "› " : "  "}/{s.name}
                  </Text>
                </Box>
                <Box width={descColWidth}>
                  <Text
                    color={selected ? TEXT_PRIMARY : TEXT_DIM}
                    wrap="truncate"
                  >
                    {s.description}
                  </Text>
                </Box>
              </Box>
            );
          })}
          <Text color={TEXT_DIM} italic>
            tab cycle · shift+tab back · ↑↓ select
            {suggestions.length > SLASH_AUTOCOMPLETE_MAX
              ? ` · ${suggestions.length - SLASH_AUTOCOMPLETE_MAX} more`
              : ""}
          </Text>
        </Box>
      )}
      {isPasteMode && (
        <Box>
          <Text color={TEXT_DIM} italic>
            enter to send · esc to clear
          </Text>
        </Box>
      )}
      {queued && (
        <Box>
          <Text color={GOLD} dimColor italic>
            message queued — will send when goose finishes
          </Text>
        </Box>
      )}
    </Box>
  );
});

export interface ToolCallRange {
  responseItemIndex: number;
  startLine: number;
  endLine: number;
}

export interface ContentLayout {
  lines: React.ReactElement[];
  toolCallRanges: ToolCallRange[];
}

function buildContentLines({
  turn,
  turnIndex,
  width,
  loading,
  status,
  spinIdx,
  selectedToolCallIdx,
  queuedMessages,
}: {
  turn: Turn | undefined;
  turnIndex: number;
  width: number;
  loading: boolean;
  status: string;
  spinIdx: number;
  selectedToolCallIdx: number | null;
  queuedMessages: string[];
}): ContentLayout {
  const lines: React.ReactElement[] = [];
  const toolCallRanges: ToolCallRange[] = [];
  if (!turn) return { lines, toolCallRanges };

  const safeWidth = Math.max(width, 20);

  const turnId = String(turnIndex);
  lines.push(
    ...renderUserPrompt(
      turn.userText,
      safeWidth,
      turnId,
      (text: string, availableWidth: number) => {
        const flat = text.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
        const safeWidth = Math.max(availableWidth, 10);
        const maxPreview = Math.max(
          safeWidth - 30,
          Math.min(SENT_PREVIEW_LEN, safeWidth - 10),
        );
        if (flat.length <= maxPreview + 10) {
          return (
            <Box width={safeWidth}>
              <Text color={TEXT_PRIMARY} bold wrap="wrap">
                {flat}
              </Text>
            </Box>
          );
        }
        const preview = flat.slice(0, maxPreview) + "…";
        const remaining = flat.length - maxPreview;
        return (
          <Box width={safeWidth}>
            <Text color={TEXT_PRIMARY} bold wrap="wrap">
              {preview}
            </Text>
            <Text color={TEXT_DIM}>
              {" "}
              ({remaining.toLocaleString()} more chars)
            </Text>
          </Box>
        );
      },
    ),
  );

  let tcIdx = 0;

  for (let i = 0; i < turn.responseItems.length; i++) {
    const item = turn.responseItems[i]!;

    if (item.itemType === "tool_call") {
      const isSelected = selectedToolCallIdx === tcIdx;
      const rendered = renderToolCallItem(item, i, safeWidth, isSelected);
      const startLine = lines.length;
      lines.push(...rendered);
      toolCallRanges.push({
        responseItemIndex: i,
        startLine,
        endLine: lines.length - 1,
      });
      tcIdx++;
    } else if (item.itemType === "error") {
      lines.push(...renderErrorItem(item, i, safeWidth));
    } else if (item.itemType === "content_chunk") {
      lines.push(...renderContentItem(item, i, safeWidth));
    }
  }

  if (loading) {
    lines.push(...renderLoadingIndicator(status, spinIdx, safeWidth));
  }

  lines.push(...renderQueuedMessages(queuedMessages, safeWidth));

  return { lines, toolCallRanges };
}

const Viewport = React.memo(function Viewport({
  lines,
  height,
  width,
  scrollOffset,
}: {
  lines: React.ReactElement[];
  height: number;
  width: number;
  scrollOffset: number;
}) {
  const total = lines.length;
  const overflows = total > height;

  const contentHeight = overflows ? Math.max(height - 2, 1) : height;

  const maxEnd = total;
  const minEnd = Math.min(contentHeight, total);
  const endIdx = Math.max(minEnd, Math.min(maxEnd - scrollOffset, maxEnd));
  const startIdx = Math.max(0, endIdx - contentHeight);

  const visible = lines.slice(startIdx, endIdx);

  const padCount = contentHeight - visible.length;

  const elements: React.ReactElement[] = [];

  if (overflows) {
    const above = startIdx;
    elements.push(
      <Box key="si-up" width={width} height={1} justifyContent="center">
        {above > 0 ? (
          <Text color={TEXT_DIM}>▲ {above} more (↑)</Text>
        ) : (
          <Text> </Text>
        )}
      </Box>,
    );
  }

  for (let i = 0; i < padCount; i++) {
    elements.push(emptyLine(`vp-pad-${i}`, width));
  }
  elements.push(...visible);

  if (overflows) {
    const below = total - endIdx;
    elements.push(
      <Box key="si-dn" width={width} height={1} justifyContent="center">
        {below > 0 ? (
          <Text color={TEXT_DIM}>▼ {below} more (↓)</Text>
        ) : (
          <Text> </Text>
        )}
      </Box>,
    );
  }

  const constrainedWidth = Math.max(width, 10);
  const constrainedHeight = Math.max(height, 1);

  return (
    <Box
      flexDirection="column"
      height={constrainedHeight}
      width={constrainedWidth}
    >
      {elements}
    </Box>
  );
});

const SplashScreen = React.memo(function SplashScreen({
  animFrame,
  width,
  height,
  status,
  loading,
  spinIdx,
}: {
  animFrame: number;
  width: number;
  height: number;
  status: string;
  loading: boolean;
  spinIdx: number;
}) {
  const frame = GOOSE_FRAMES[animFrame % GOOSE_FRAMES.length]!;
  const statusColor =
    status === "ready" ? TEAL : isErrorStatus(status) ? CRANBERRY : TEXT_DIM;

  // goose art + title + tagline + status row (no guide)
  const baseContentHeight = frame.length + 1 + 1 + 1 + 2 + 1;
  // header line + commands + key lines + top margin
  const fullGuideLines =
    1 + STARTUP_GUIDE_COMMANDS.length + STARTUP_GUIDE_KEYS.length + 1;
  const safeWidth = Math.max(width, 20);
  const safeHeight = Math.max(height, 10);
  // Only show the guide when ready and it fits without clipping the splash.
  const showGuide =
    status === "ready" &&
    !loading &&
    safeHeight >= baseContentHeight + fullGuideLines;
  const contentHeight = baseContentHeight + (showGuide ? fullGuideLines : 0);

  const topPad = Math.max(0, Math.floor((height - contentHeight) / 2));

  // Leave room for left margin + cmd column + gap
  const guideCmdWidth = 14;
  const guideDescWidth = Math.max(safeWidth - guideCmdWidth - 4, 12);

  return (
    <Box
      flexDirection="column"
      alignItems="center"
      width={safeWidth}
      height={safeHeight}
      overflow="hidden"
    >
      {topPad > 0 && <Box height={topPad} />}
      <Box flexDirection="column" alignItems="center">
        {frame.map((line, i) => (
          <Text key={i} color={TEXT_PRIMARY}>
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={TEXT_PRIMARY} bold>
          goose
        </Text>
      </Box>
      <Box alignItems="center">
        <Text color={TEXT_DIM}>your on-machine AI agent</Text>
      </Box>
      <Box marginTop={2} gap={1} alignItems="center">
        {loading && <Spinner idx={spinIdx} />}
        <Text color={statusColor}>{status}</Text>
      </Box>
      {showGuide && (
        <Box
          flexDirection="column"
          marginTop={1}
          width={Math.min(safeWidth, 56)}
        >
          <Text color={TEXT_DIM}>· inline commands</Text>
          {STARTUP_GUIDE_COMMANDS.map(({ cmd, desc }) => (
            <Box key={cmd} height={1}>
              <Box width={guideCmdWidth}>
                <Text color={TEAL}>  {cmd}</Text>
              </Box>
              <Box width={guideDescWidth}>
                <Text color={TEXT_DIM} wrap="truncate">
                  {desc}
                </Text>
              </Box>
            </Box>
          ))}
          {STARTUP_GUIDE_KEYS.map(({ key, desc }) => (
            <Box key={key} height={1}>
              <Box width={guideCmdWidth}>
                <Text color={TEAL}>  {key}</Text>
              </Box>
              <Box width={guideDescWidth}>
                <Text color={TEXT_DIM} wrap="truncate">
                  {desc}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
});

function App({
  serverConnection,
  initialPrompt,
}: {
  serverConnection: Stream | string;
  initialPrompt?: string;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // `useStdout()` returns the live stream but does not trigger a React
  // re-render when the terminal is resized. Without this subscription the
  // outer Box keeps its old width/height after SIGWINCH, producing a
  // misaligned frame until some other state change forces a render.
  const [termSize, setTermSize] = useState(() => ({
    width: stdout?.columns ?? 80,
    height: stdout?.rows ?? 24,
  }));
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setTermSize({
        width: stdout.columns ?? 80,
        height: stdout.rows ?? 24,
      });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  const termWidth = termSize.width;
  const termHeight = termSize.height;

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("connecting…");
  const [spinIdx, setSpinIdx] = useState(0);
  const [gooseFrame, setGooseFrame] = useState(0);
  const [bannerVisible, setBannerVisible] = useState(true);
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);

  const [viewTurnIdx, setViewTurnIdx] = useState(-1);
  const [selectedToolCallIdx, setSelectedToolCallIdx] = useState<number | null>(
    null,
  );
  const [toolCallExpanded, setToolCallExpanded] = useState(false);
  const [toolCallExpandedScroll, setToolCallExpandedScroll] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [pastedFull, setPastedFull] = useState<string | null>(null);
  // First Ctrl+D arms exit; second within CTRL_D_EXIT_MS confirms.
  const [exitHint, setExitHint] = useState(false);
  const pendingExitRef = useRef(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [slashSuggestionIdx, setSlashSuggestionIdx] = useState(0);
  // While Tab-cycling, keep matching against the original typed prefix so the
  // suggestion list does not collapse when the input is filled with a candidate.
  const [slashCyclePrefix, setSlashCyclePrefix] = useState<string | null>(null);
  // Remount MultilineInput after autocomplete so the caret sits at the end
  // (ready for command arguments).
  const [inputCursorKey, setInputCursorKey] = useState(0);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  type Overlay =
    | { screen: "configure"; intent: ConfigureIntent }
    | { screen: "extensions" }
    | { screen: "diff"; content: string; truncated: boolean };
  const [overlay, setOverlay] = useState<Overlay | null>(null);

  const slashSuggestions = useMemo(
    () => matchSlashCommands(slashCyclePrefix ?? input),
    [input, slashCyclePrefix],
  );
  useEffect(() => {
    // Don't reset the highlight while Tab is cycling through matches.
    if (slashCyclePrefix === null) {
      setSlashSuggestionIdx(0);
    }
  }, [input, slashCyclePrefix]);

  const clientRef = useRef<GooseClient | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sessionCwdRef = useRef<string>(process.cwd());
  const streamBuf = useRef("");
  const sentInitialPrompt = useRef(false);
  const queueRef = useRef<string[]>([]);
  const isProcessingRef = useRef(false);

  // Only run the animation tick when something is actually animating:
  // the splash goose while the banner is up, or the spinner while loading.
  // Otherwise we were re-rendering the entire viewport every 300ms forever,
  // which rebuilds every turn's markdown and can OOM long-running sessions.
  useEffect(() => {
    if (!bannerVisible && !loading) return;
    const t = setInterval(() => {
      if (loading) setSpinIdx((i) => (i + 1) % SPINNER_FRAMES.length);
      if (bannerVisible) setGooseFrame((f) => (f + 1) % GOOSE_FRAMES.length);
    }, 300);
    return () => clearInterval(t);
  }, [bannerVisible, loading]);

  useEffect(() => {
    if (turns.length > 0) setBannerVisible(false);
  }, [turns]);

  useEffect(() => {
    setSelectedToolCallIdx(null);
    setToolCallExpanded(false);
    setToolCallExpandedScroll(0);
    setScrollOffset(0);
  }, [viewTurnIdx, turns.length]);

  // Re-layout invalidates any scroll offset we were holding (line counts
  // change with width), so snap back to the latest content on resize.
  useEffect(() => {
    setScrollOffset(0);
  }, [termWidth, termHeight]);

  const appendAgent = useCallback((text: string) => {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const last = { ...prev[prev.length - 1]! };
      const newItems = [...last.responseItems];

      if (
        newItems.length > 0 &&
        newItems[newItems.length - 1]!.itemType === "content_chunk"
      ) {
        const lastItem = newItems[newItems.length - 1] as ContentChunk & {
          itemType: "content_chunk";
        };
        if (lastItem.content.type === "text") {
          newItems[newItems.length - 1] = {
            ...lastItem,
            content: {
              ...lastItem.content,
              text: lastItem.content.text + text,
            },
          };
        } else {
          newItems.push({
            itemType: "content_chunk",
            content: { type: "text", text },
          });
        }
      } else {
        newItems.push({
          itemType: "content_chunk",
          content: { type: "text", text },
        });
      }

      return [...prev.slice(0, -1), { ...last, responseItems: newItems }];
    });
  }, []);

  const appendError = useCallback((errorMessage: string) => {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const last = { ...prev[prev.length - 1]! };
      const newItems = [...last.responseItems];
      newItems.push({ itemType: "error", message: errorMessage });
      return [...prev.slice(0, -1), { ...last, responseItems: newItems }];
    });
  }, []);

  const handleToolCall = useCallback((tc: ToolCall) => {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const last = { ...prev[prev.length - 1]! };
      const newItems = [...last.responseItems];
      const newById = new Map(last.toolCallsById);
      const index = newItems.length;
      newItems.push({ ...tc, itemType: "tool_call" });
      newById.set(tc.toolCallId, index);
      return [
        ...prev.slice(0, -1),
        { ...last, responseItems: newItems, toolCallsById: newById },
      ];
    });
  }, []);

  const handleToolCallUpdate = useCallback((update: ToolCallUpdate) => {
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const last = { ...prev[prev.length - 1]! };
      const index = last.toolCallsById.get(update.toolCallId);
      if (index === undefined) return prev;
      const item = last.responseItems[index];
      if (!item || item.itemType !== "tool_call") return prev;
      const updated: ToolCall & { itemType: "tool_call" } = { ...item };
      if (update.title != null) updated.title = update.title;
      if (update.status != null) updated.status = update.status;
      if (update.kind != null) updated.kind = update.kind;
      if (update.rawInput !== undefined) updated.rawInput = update.rawInput;
      if (update.rawOutput !== undefined) updated.rawOutput = update.rawOutput;
      if (update.content != null) updated.content = update.content;
      if (update.locations != null) updated.locations = update.locations;
      const newItems = [...last.responseItems];
      newItems[index] = updated;
      return [...prev.slice(0, -1), { ...last, responseItems: newItems }];
    });
  }, []);

  const addUserTurn = useCallback((text: string) => {
    setTurns((prev) => [
      ...prev,
      { userText: text, responseItems: [], toolCallsById: new Map() },
    ]);
    setViewTurnIdx(-1);
    setSelectedToolCallIdx(null);
    setToolCallExpanded(false);
    setToolCallExpandedScroll(0);
    setScrollOffset(0);
  }, []);

  const executePrompt = useCallback(
    async (text: string) => {
      const client = clientRef.current;
      const sid = sessionIdRef.current;
      if (!client || !sid) return;

      addUserTurn(text);
      setLoading(true);
      setStatus("thinking…");
      streamBuf.current = "";

      try {
        const result = await client.prompt({
          sessionId: sid,
          prompt: [{ type: "text", text }],
        });
        if (streamBuf.current) appendAgent("");
        setStatus(
          result.stopReason === "end_turn"
            ? "ready"
            : `stopped: ${result.stopReason}`,
        );
      } catch (e: unknown) {
        const errorMsg = formatError(e);
        setStatus(`error`);
        appendError(errorMsg);
      } finally {
        setLoading(false);
      }
    },
    [appendAgent, appendError, addUserTurn],
  );

  const processQueue = useCallback(async () => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    while (queueRef.current.length > 0) {
      const next = queueRef.current.shift()!;
      setQueuedMessages([...queueRef.current]);
      await executePrompt(next);
    }
    isProcessingRef.current = false;
  }, [executePrompt]);

  const sendPrompt = useCallback(
    async (text: string) => {
      await executePrompt(text);
      if (queueRef.current.length > 0) processQueue();
    },
    [executePrompt, processQueue],
  );

  const createSession = useCallback(
    async (client: GooseClient) => {
      setStatus("creating session…");
      setLoading(true);
      try {
        const cwd = process.cwd();
        sessionCwdRef.current = cwd;
        const session = await client.newSession({
          cwd,
          mcpServers: [],
        });
        sessionIdRef.current = session.sessionId;
        setLoading(false);
        setStatus("ready");

        if (initialPrompt && !sentInitialPrompt.current) {
          sentInitialPrompt.current = true;
          await sendPrompt(initialPrompt);
          setTimeout(() => exit(), 100);
        }
      } catch (e: unknown) {
        const errorMsg = formatError(e);
        setStatus(`failed: ${errorMsg}`);
        setLoading(false);
      }
    },
    [initialPrompt, sendPrompt, exit],
  );

  const handleOnboardingComplete = useCallback(() => {
    setNeedsOnboarding(false);
    const client = clientRef.current;
    if (client) createSession(client);
  }, [createSession]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setStatus("initializing…");

        const client = new GooseClient(
          () => ({
            requestPermission: async (
              params: RequestPermissionRequest,
            ): Promise<RequestPermissionResponse> => {
              const optionId = params.options?.[0]?.optionId ?? "approve";
              return {
                outcome: {
                  outcome: "selected",
                  optionId,
                },
              };
            },
            sessionUpdate: async (params: SessionNotification) => {
              const update = params.update;
              if (update.sessionUpdate === "agent_message_chunk") {
                if (update.content.type === "text") {
                  streamBuf.current += update.content.text;
                  appendAgent(update.content.text);
                }
              } else if (update.sessionUpdate === "tool_call") {
                handleToolCall(update);
              } else if (update.sessionUpdate === "tool_call_update") {
                handleToolCallUpdate(update);
              } else {
                const usage = parseAcpUsageUpdate(update);
                if (usage) setContextUsage(usage);
              }
            },
            unstable_sessionUpdate: async (notification) => {
              const update = notification.update;
              if (update.sessionUpdate === "usage_update") {
                if (
                  typeof update.used === "number" &&
                  typeof update.contextLimit === "number" &&
                  update.contextLimit > 0
                ) {
                  setContextUsage({
                    used: update.used,
                    size: update.contextLimit,
                  });
                }
              } else if (update.sessionUpdate === "status_message") {
                if (update.status.type === "progress") {
                  setStatus(update.status.message);
                }
              }
            },
          }),
          serverConnection,
        );

        if (cancelled) return;
        clientRef.current = client;

        setStatus("handshaking…");
        await client.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "goose-text", version: "0.1.0" },
          clientCapabilities: {},
        });
        if (cancelled) return;

        setStatus("checking provider…");
        let hasProvider = false;
        try {
          const resp = await client.goose.defaultsRead_unstable({});
          hasProvider =
            resp.providerId != null &&
            resp.providerId !== "" &&
            resp.providerId !== "null";
        } catch {
          hasProvider = false;
        }
        if (cancelled) return;

        if (!hasProvider && !initialPrompt) {
          setNeedsOnboarding(true);
          setLoading(false);
          setStatus("setup required");
          return;
        }

        await createSession(client);
      } catch (e: unknown) {
        if (cancelled) return;
        const errorMsg = formatError(e);
        setStatus(`failed: ${errorMsg}`);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    serverConnection,
    initialPrompt,
    createSession,
    appendAgent,
    handleToolCall,
    handleToolCallUpdate,
    exit,
  ]);

  const addLocalTurn = useCallback((userText: string, message?: string) => {
    setTurns((prev) => [
      ...prev,
      {
        userText,
        responseItems: message
          ? [
              {
                itemType: "content_chunk",
                content: { type: "text", text: message },
              },
            ]
          : [],
        toolCallsById: new Map(),
      },
    ]);
    setViewTurnIdx(-1);
    setSelectedToolCallIdx(null);
    setToolCallExpanded(false);
    setToolCallExpandedScroll(0);
    setScrollOffset(0);
  }, []);

  const clearLocalTurns = useCallback(() => {
    setTurns([]);
    setViewTurnIdx(-1);
    setSelectedToolCallIdx(null);
    setToolCallExpanded(false);
    setToolCallExpandedScroll(0);
    setScrollOffset(0);
    setBannerVisible(true);
    setContextUsage(null);
  }, []);

  const runSlashCommand = useCallback(
    (raw: string): boolean => {
      const result = tryRunSlashCommand(raw, {
        cwd: sessionCwdRef.current,
      });
      if (!result.handled) return false;

      if ("action" in result) {
        if (result.action === "exit") {
          exit();
          return true;
        }
        if (result.action === "clear") {
          // Clear local UI immediately (matches desktop), drop any queued
          // prompts, then tell the agent so the session history is wiped too.
          clearLocalTurns();
          queueRef.current = [];
          setQueuedMessages([]);
          if (loading || isProcessingRef.current) {
            queueRef.current.push("/clear");
            setQueuedMessages(["/clear"]);
          } else {
            void sendPrompt("/clear");
          }
          return true;
        }
        if (result.action === "agent") {
          if (loading || isProcessingRef.current) {
            queueRef.current.push(result.text);
            setQueuedMessages([...queueRef.current]);
          } else {
            void sendPrompt(result.text);
          }
          return true;
        }
      }

      if ("overlay" in result) {
        if (result.overlay === "diff") {
          setOverlay({
            screen: "diff",
            content: result.content,
            truncated: result.truncated,
          });
          return true;
        }
        if (result.overlay === "configure") {
          if (!sessionIdRef.current) {
            addLocalTurn(raw, "session not ready");
            return true;
          }
          setOverlay({ screen: "configure", intent: result.intent });
          return true;
        }
        if (result.overlay === "extensions") {
          if (!sessionIdRef.current) {
            addLocalTurn(raw, "session not ready");
            return true;
          }
          setOverlay({ screen: "extensions" });
          return true;
        }
      }

      addLocalTurn(raw, "message" in result ? result.message : undefined);
      return true;
    },
    [addLocalTurn, clearLocalTurns, exit, loading, sendPrompt],
  );

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setInput("");
      setPastedFull(null);
      setSlashCyclePrefix(null);
      setSlashSuggestionIdx(0);
      setViewTurnIdx(-1);
      setSelectedToolCallIdx(null);
      setToolCallExpanded(false);
      setToolCallExpandedScroll(0);
      setScrollOffset(0);

      if (trimmed.startsWith("/")) {
        if (runSlashCommand(trimmed)) return;
        // Unknown slash form that was not handled — still try as agent text.
      }

      if (loading || isProcessingRef.current) {
        queueRef.current.push(trimmed);
        setQueuedMessages([...queueRef.current]);
      } else {
        sendPrompt(trimmed);
      }
    },
    [loading, sendPrompt, runSlashCommand],
  );

  const handleInputChange = useCallback((value: string) => {
    setSlashCyclePrefix(null);
    setInput(value);
  }, []);

  /** Replace input from autocomplete and place the caret after the text. */
  const setInputFromAutocomplete = useCallback((value: string) => {
    setInput(value);
    setInputCursorKey((k) => k + 1);
  }, []);

  const applySlashSuggestion = useCallback(
    (suggestion: SlashSuggestion) => {
      setSlashCyclePrefix(null);
      // completion includes a trailing space so arguments can be typed next.
      setInputFromAutocomplete(suggestion.completion);
      setSlashSuggestionIdx(0);
    },
    [setInputFromAutocomplete],
  );

  /**
   * Tab / Shift+Tab slash completion:
   * - unique match → insert full command with trailing space, caret at end
   * - multiple matches → cycle selection; fill `/${name} ` so args are ready
   *   (list stays open via slashCyclePrefix)
   */
  const handleTabSuggestion = useCallback(
    (shift: boolean) => {
      const source = slashCyclePrefix ?? input;
      const matches = matchSlashCommands(source);
      const visible = matches.slice(0, SLASH_AUTOCOMPLETE_MAX);
      if (visible.length === 0) return;

      if (visible.length === 1) {
        applySlashSuggestion(visible[0]);
        return;
      }

      const n = visible.length;
      let nextIdx: number;
      if (slashCyclePrefix === null) {
        // First Tab: lock the typed prefix and accept the current highlight.
        // Shift+Tab starts on the previous item.
        setSlashCyclePrefix(source);
        nextIdx = shift
          ? (Math.min(slashSuggestionIdx, n - 1) - 1 + n) % n
          : Math.min(slashSuggestionIdx, n - 1);
      } else {
        nextIdx = shift
          ? (slashSuggestionIdx - 1 + n) % n
          : (slashSuggestionIdx + 1) % n;
      }

      setSlashSuggestionIdx(nextIdx);
      // Trailing space + caret at end: user can type args or Tab to cycle more.
      setInputFromAutocomplete(visible[nextIdx].completion);
    },
    [
      input,
      slashCyclePrefix,
      slashSuggestionIdx,
      applySlashSuggestion,
      setInputFromAutocomplete,
    ],
  );

  /** Arrow selection: keep the input in sync while Tab-cycling. */
  const handleSelectSuggestion = useCallback(
    (index: number) => {
      setSlashSuggestionIdx(index);
      if (slashCyclePrefix !== null) {
        const pick = slashSuggestions[index];
        if (pick) setInputFromAutocomplete(pick.completion);
      }
    },
    [slashCyclePrefix, slashSuggestions, setInputFromAutocomplete],
  );

  const PAD_X = 2;
  const PAD_TOP = 0;
  const PAD_BOTTOM = 0;
  const safeTermWidth = Math.max(termWidth, 40);
  const safeTermHeight = Math.max(termHeight, 10);
  const contentWidth = Math.max(safeTermWidth - PAD_X * 2, 20);

  const effectiveTurnIdx = viewTurnIdx === -1 ? turns.length - 1 : viewTurnIdx;
  const currentTurn = turns[effectiveTurnIdx];
  const isViewingHistory = viewTurnIdx !== -1 && viewTurnIdx < turns.length - 1;
  const isLatest = !isViewingHistory;
  const showInputBar = !initialPrompt && !isViewingHistory;

  const headerH = 2;
  const statusBarH = 2; // rule + status/context line
  const isPasteMode = pastedFull !== null;
  const inputContentRows = showInputBar
    ? isPasteMode
      ? 1
      : Math.min(Math.max(input.split("\n").length, 1), INPUT_MAX_ROWS)
    : 0;
  const slashSuggestLines =
    showInputBar && !isPasteMode && slashSuggestions.length > 0
      ? Math.min(slashSuggestions.length, SLASH_AUTOCOMPLETE_MAX) + 1 // rows + tip line
      : 0;
  const inputExtraLines =
    (isPasteMode ? 1 : 0) +
    (queuedMessages.length > 0 ? 1 : 0) +
    slashSuggestLines;
  const inputBarH = showInputBar
    ? 2 + inputContentRows + inputExtraLines + 1 // +1 for marginTop gap above input bar
    : 0;
  const historyBarH = isViewingHistory ? 2 : 0;
  const viewportHeight = Math.max(
    safeTermHeight -
      PAD_TOP -
      PAD_BOTTOM -
      headerH -
      inputBarH -
      historyBarH -
      statusBarH,
    3,
  );

  const contentLayout = useMemo(
    () =>
      buildContentLines({
        turn: currentTurn,
        turnIndex: effectiveTurnIdx,
        width: contentWidth,
        loading: isLatest && loading,
        status,
        spinIdx,
        selectedToolCallIdx,
        queuedMessages: isLatest ? queuedMessages : [],
      }),
    [
      currentTurn,
      effectiveTurnIdx,
      contentWidth,
      isLatest,
      loading,
      status,
      spinIdx,
      selectedToolCallIdx,
      queuedMessages,
    ],
  );
  const contentLines = contentLayout.lines;
  const toolCallRanges = contentLayout.toolCallRanges;

  useEffect(() => {
    if (
      selectedToolCallIdx !== null &&
      selectedToolCallIdx >= toolCallRanges.length
    ) {
      setSelectedToolCallIdx(
        toolCallRanges.length === 0 ? null : toolCallRanges.length - 1,
      );
    }
  }, [toolCallRanges.length, selectedToolCallIdx]);

  const selectedToolCallInfo = useMemo<ToolCallInfo | null>(() => {
    if (selectedToolCallIdx === null || !currentTurn) return null;
    const range = toolCallRanges[selectedToolCallIdx];
    if (!range) return null;
    const item = currentTurn.responseItems[range.responseItemIndex];
    if (!item || item.itemType !== "tool_call") return null;
    return {
      toolCallId: item.toolCallId,
      title: item.title,
      status: item.status ?? "pending",
      kind: item.kind,
      rawInput: item.rawInput,
      rawOutput: item.rawOutput,
      content: item.content,
      locations: item.locations,
    };
  }, [selectedToolCallIdx, toolCallRanges, currentTurn]);

  // Compute a scroll offset that keeps the given tool-call range fully
  // visible, moving just enough from the current offset. scrollOffset is
  // measured in lines-from-bottom, matching Viewport's math.
  const scrollOffsetForRange = useCallback(
    (range: ToolCallRange, current: number): number => {
      const total = contentLines.length;
      const overflows = total > viewportHeight;
      const contentHeight = overflows
        ? Math.max(viewportHeight - 2, 1)
        : viewportHeight;
      if (!overflows) return 0;
      const maxOffset = total - contentHeight;
      const minForTop = total - range.startLine - contentHeight;
      const maxForBottom = total - range.endLine - 1;
      const lo = Math.max(0, minForTop);
      const hi = Math.max(lo, Math.min(maxOffset, maxForBottom));
      if (current < lo) return lo;
      if (current > hi) return hi;
      return current;
    },
    [contentLines.length, viewportHeight],
  );

  const moveSelection = useCallback(
    (direction: -1 | 1) => {
      if (toolCallRanges.length === 0) return false;
      let nextIdx: number;
      if (selectedToolCallIdx === null) {
        nextIdx = direction === -1 ? toolCallRanges.length - 1 : 0;
      } else {
        nextIdx = selectedToolCallIdx + direction;
        if (nextIdx < 0 || nextIdx >= toolCallRanges.length) return false;
      }
      setSelectedToolCallIdx(nextIdx);
      const range = toolCallRanges[nextIdx]!;
      setScrollOffset((prev) => scrollOffsetForRange(range, prev));
      return true;
    },
    [toolCallRanges, selectedToolCallIdx, scrollOffsetForRange],
  );

  useEffect(() => {
    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    };
  }, []);

  useInput(
    (ch, key) => {
      if (toolCallExpanded) return;

      // Double Ctrl+D to exit (ESC no longer quits).
      if (ch === "d" && key.ctrl) {
        if (pendingExitRef.current) {
          if (exitTimerRef.current) {
            clearTimeout(exitTimerRef.current);
            exitTimerRef.current = null;
          }
          pendingExitRef.current = false;
          setExitHint(false);
          exit();
          return;
        }
        pendingExitRef.current = true;
        setExitHint(true);
        exitTimerRef.current = setTimeout(() => {
          pendingExitRef.current = false;
          setExitHint(false);
          exitTimerRef.current = null;
        }, CTRL_D_EXIT_MS);
        return;
      }

      // Any other key cancels a pending double-Ctrl+D exit.
      if (pendingExitRef.current) {
        if (exitTimerRef.current) {
          clearTimeout(exitTimerRef.current);
          exitTimerRef.current = null;
        }
        pendingExitRef.current = false;
        setExitHint(false);
      }

      if (ch === "c" && key.ctrl) {
        exit();
        return;
      }

      if (!loading && sessionIdRef.current) {
        if (key.ctrl && (ch === "p" || ch === "P")) {
          setOverlay({ screen: "configure", intent: "provider" });
          return;
        }
        if (key.ctrl && (ch === "m" || ch === "M")) {
          setOverlay({ screen: "configure", intent: "model" });
          return;
        }
        if (key.ctrl && (ch === "e" || ch === "E")) {
          setOverlay({ screen: "extensions" });
          return;
        }
        if (ch === "g" && key.ctrl) {
          setOverlay({ screen: "configure", intent: "provider" });
          return;
        }
      }

      const viewingHistory =
        viewTurnIdx !== -1 && viewTurnIdx < turns.length - 1;
      const slashAutocompleteOpen =
        showInputBar && pastedFull === null && slashSuggestions.length > 0;
      const multilineOwnsArrows =
        !initialPrompt &&
        !viewingHistory &&
        pastedFull === null &&
        input.includes("\n");

      if (ch === " " && selectedToolCallIdx !== null) {
        setToolCallExpandedScroll(0);
        setToolCallExpanded(true);
        return;
      }

      if ((key.upArrow || key.downArrow) && !key.shift) {
        // Slash popup owns plain ↑↓ while completing a command name.
        if (slashAutocompleteOpen && !key.meta) return;
        if (multilineOwnsArrows) return;

        if (key.meta) {
          const step = SCROLL_STEP * SCROLL_FAST_MULTIPLIER;
          if (key.upArrow) {
            setScrollOffset((prev) => prev + step);
          } else {
            setScrollOffset((prev) => Math.max(prev - step, 0));
          }
          return;
        }

        if (toolCallRanges.length > 0) {
          const direction: -1 | 1 = key.upArrow ? -1 : 1;
          if (moveSelection(direction)) return;
          if (selectedToolCallIdx !== null) {
            setSelectedToolCallIdx(null);
          }
        }

        const step = SCROLL_STEP;
        if (key.upArrow) {
          setScrollOffset((prev) => prev + step);
        } else {
          setScrollOffset((prev) => Math.max(prev - step, 0));
        }
        return;
      }

      if (key.upArrow && key.shift) {
        setTurns((cur) => {
          if (cur.length <= 1) return cur;
          setViewTurnIdx((prev) => {
            const eff = prev === -1 ? cur.length - 1 : prev;
            return Math.max(eff - 1, 0);
          });
          return cur;
        });
        return;
      }
      if (key.downArrow && key.shift) {
        setTurns((cur) => {
          if (cur.length <= 1) return cur;
          setViewTurnIdx((prev) => {
            if (prev === -1) return -1;
            const next = prev + 1;
            return next >= cur.length ? -1 : next;
          });
          return cur;
        });
        return;
      }
    },
    { isActive: !needsOnboarding && !overlay },
  );

  if (needsOnboarding && clientRef.current) {
    return (
      <Box flexDirection="column" width={safeTermWidth} height={safeTermHeight}>
        <Onboarding
          client={clientRef.current}
          width={safeTermWidth}
          height={safeTermHeight}
          onComplete={handleOnboardingComplete}
        />
      </Box>
    );
  }

  if (overlay && overlay.screen === "diff") {
    return (
      <DiffViewer
        content={overlay.content}
        truncated={overlay.truncated}
        width={safeTermWidth}
        height={safeTermHeight}
        onClose={() => setOverlay(null)}
      />
    );
  }

  if (overlay && clientRef.current && sessionIdRef.current) {
    if (overlay.screen === "configure") {
      const intent = overlay.intent;
      return (
        <Box
          flexDirection="column"
          width={safeTermWidth}
          height={safeTermHeight}
        >
          <ConfigureScreen
            client={clientRef.current}
            sessionId={sessionIdRef.current}
            width={safeTermWidth}
            height={safeTermHeight}
            onComplete={() => {
              setOverlay(null);
              setStatus("ready");
            }}
            onCancel={() => setOverlay(null)}
            initialIntent={intent}
          />
        </Box>
      );
    } else if (overlay.screen === "extensions") {
      return (
        <Box
          flexDirection="column"
          width={safeTermWidth}
          height={safeTermHeight}
        >
          <ExtensionsManager
            client={clientRef.current}
            sessionId={sessionIdRef.current}
            height={safeTermHeight}
            onClose={() => setOverlay(null)}
          />
        </Box>
      );
    }
  }

  return (
    <Box
      flexDirection="column"
      width={safeTermWidth}
      height={safeTermHeight}
      paddingX={PAD_X}
      paddingTop={PAD_TOP}
      paddingBottom={PAD_BOTTOM}
    >
      {bannerVisible ? (
        <SplashScreen
          animFrame={gooseFrame}
          width={contentWidth}
          height={Math.max(
            safeTermHeight -
              PAD_TOP -
              PAD_BOTTOM -
              inputBarH -
              statusBarH,
            0,
          )}
          status={exitHint ? "press Ctrl+D again to exit" : status}
          loading={loading}
          spinIdx={spinIdx}
        />
      ) : (
        <>
          <Header
            width={contentWidth}
            turnInfo={
              turns.length > 1
                ? { current: effectiveTurnIdx + 1, total: turns.length }
                : undefined
            }
          />

          {toolCallExpanded && selectedToolCallInfo ? (
            <ToolCallExpanded
              info={selectedToolCallInfo}
              width={contentWidth}
              height={viewportHeight}
              scrollOffset={toolCallExpandedScroll}
              onScroll={setToolCallExpandedScroll}
              onClose={() => {
                setToolCallExpanded(false);
                setToolCallExpandedScroll(0);
              }}
            />
          ) : (
            <Viewport
              lines={contentLines}
              height={viewportHeight}
              width={contentWidth}
              scrollOffset={scrollOffset}
            />
          )}

          {isViewingHistory && (
            <Box flexDirection="column" width={contentWidth} flexShrink={0}>
              <Rule width={contentWidth} />
              <Box justifyContent="center" width={contentWidth}>
                <Text color={GOLD}>
                  turn {effectiveTurnIdx + 1}/{turns.length}
                </Text>
                <Text color={TEXT_DIM}> — shift+↓ to return</Text>
              </Box>
            </Box>
          )}
        </>
      )}
      {showInputBar && (
        <InputBar
          width={contentWidth}
          input={input}
          onChange={handleInputChange}
          onSubmit={handleSubmit}
          queued={queuedMessages.length > 0}
          scrollHint={!bannerVisible && turns.length > 1}
          placeholder={
            bannerVisible
              ? "type / for commands · Tab to cycle"
              : undefined
          }
          focused={showInputBar}
          pastedFull={pastedFull}
          onPastedFullChange={setPastedFull}
          suggestions={slashSuggestions}
          selectedSuggestion={Math.min(
            slashSuggestionIdx,
            Math.max(slashSuggestions.length - 1, 0),
          )}
          onSelectSuggestion={handleSelectSuggestion}
          onTabSuggestion={handleTabSuggestion}
          inputCursorKey={inputCursorKey}
        />
      )}
      <StatusBar
        width={contentWidth}
        status={exitHint ? "press Ctrl+D again to exit" : status}
        loading={loading}
        spinIdx={spinIdx}
        contextUsage={contextUsage}
      />
    </Box>
  );
}

const cli = meow(
  `
  Usage
    $ goose

  Options
    --server, -s  Server URL (default: auto-launch bundled server)
    --text, -t    Send a single prompt and exit
`,
  {
    importMeta: import.meta,
    flags: {
      server: { type: "string", shortFlag: "s" },
      text: { type: "string", shortFlag: "t" },
    },
  },
);

let serverProcess: ReturnType<typeof spawn> | null = null;

async function runTextMode(serverConnection: Stream | string, prompt: string) {
  try {
    const client = new GooseClient(
      () => ({
        requestPermission: async (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> => {
          const optionId = params.options?.[0]?.optionId ?? "approve";
          return {
            outcome: {
              outcome: "selected",
              optionId,
            },
          };
        },
        sessionUpdate: async (params: SessionNotification) => {
          const update = params.update;
          if (update.sessionUpdate === "agent_message_chunk") {
            if (update.content.type === "text") {
              process.stdout.write(update.content.text);
            }
          }
        },
      }),
      serverConnection,
    );

    await client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "goose-text", version: "0.1.0" },
      clientCapabilities: {},
    });

    const session = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: prompt }],
    });

    process.stdout.write("\n");
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`Error: ${errMsg}`);
    process.exit(1);
  }
}

async function main() {
  let serverConnection: Stream | string;

  if (cli.flags.server) {
    serverConnection = cli.flags.server;
  } else {
    const binary = resolveGooseBinary();
    serverProcess = spawn(binary, ["acp"], {
      stdio: ["pipe", "pipe", "ignore"],
      detached: false,
    });

    serverProcess.on("error", (err) => {
      console.error(`Failed to start goose acp: ${err.message}`);
      process.exit(1);
    });

    const output = Writable.toWeb(
      serverProcess.stdin!,
    ) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(
      serverProcess.stdout!,
    ) as ReadableStream<Uint8Array>;
    serverConnection = ndJsonStream(output, input);
  }

  // Text mode: bypass TUI and stream directly to stdout
  if (cli.flags.text) {
    await runTextMode(serverConnection, cli.flags.text);
    cleanup();
    return;
  }

  // Interactive TUI mode
  const { waitUntilExit } = render(
    <App serverConnection={serverConnection} initialPrompt={cli.flags.text} />,
  );

  await waitUntilExit();
  cleanup();
}

function cleanup() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});

import { spawnSync } from "node:child_process";
import type { ConfigureIntent } from "./configure.js";

export interface SlashCommandContext {
  cwd: string;
}

export type SlashCommandResult =
  | { handled: true; message?: string }
  | { handled: true; overlay: "diff"; content: string; truncated: boolean }
  | { handled: true; overlay: "configure"; intent: ConfigureIntent }
  | { handled: true; overlay: "extensions" }
  | { handled: true; action: "exit" }
  | { handled: true; action: "clear"; message: string }
  | { handled: true; action: "agent"; text: string }
  | { handled: false };

export interface SlashCommand {
  name: string;
  description: string;
  /** Shown in the compact startup guide (subset of all commands). */
  guide?: boolean;
  run: (ctx: SlashCommandContext, args: string) => SlashCommandResult;
}

function isGitRepo(cwd: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

const MAX_DIFF_BYTES = 2_000_000;

function readDiff(cwd: string): { text: string; truncated: boolean } | null {
  const result = spawnSync("git", ["--no-pager", "diff", "--no-color"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 && result.status !== null) return null;
  const stdout = result.stdout ?? "";
  if (stdout.length > MAX_DIFF_BYTES) {
    return { text: stdout.slice(0, MAX_DIFF_BYTES), truncated: true };
  }
  return { text: stdout, truncated: false };
}

/** Commands executed by the agent via ACP prompt (not local UI). */
const AGENT_COMMANDS = new Set([
  "status",
  "compact",
  "summarize",
  "clear",
  "skills",
  "prompts",
  "prompt",
  "doctor",
  "goal",
  "grind",
]);

export const STARTUP_GUIDE_COMMANDS: ReadonlyArray<{
  cmd: string;
  desc: string;
}> = [
  { cmd: "/help", desc: "show all commands" },
  { cmd: "/status", desc: "model, provider, mode, tokens" },
  { cmd: "/model", desc: "switch model" },
  { cmd: "/diff", desc: "show unstaged changes" },
  { cmd: "/compact", desc: "shrink conversation context" },
  { cmd: "/skills", desc: "list or enable skills" },
  { cmd: "/clear", desc: "clear chat history" },
  { cmd: "/exit", desc: "quit session" },
];

export const STARTUP_GUIDE_KEYS: ReadonlyArray<{
  key: string;
  desc: string;
}> = [
  { key: "Enter", desc: "send · Ctrl+Enter newline · Esc/Ctrl+C exit" },
  { key: "Tab", desc: "complete /command · ↑↓ pick suggestion" },
  { key: "Ctrl+P", desc: "provider · Ctrl+M model · Ctrl+E extensions" },
];

/** Max suggestions shown in the input autocomplete popup. */
export const SLASH_AUTOCOMPLETE_MAX = 6;

export interface SlashSuggestion {
  name: string;
  description: string;
  /** Completed input text including leading `/` and trailing space. */
  completion: string;
}

/**
 * Match slash-command completions for the current input.
 * Only active while the first token is a partial command (no args yet).
 */
export function matchSlashCommands(input: string): SlashSuggestion[] {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return [];
  // After a space the user is typing args — no name completion.
  if (/\s/.test(trimmed.slice(1))) return [];

  const prefix = trimmed.slice(1).toLowerCase();
  return listSlashCommands()
    .filter((cmd) => cmd.name !== "?" && cmd.name.startsWith(prefix))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      completion: `/${cmd.name} `,
    }));
}

export function formatStartupGuide(): string {
  const lines = ["inline commands"];
  for (const { cmd, desc } of STARTUP_GUIDE_COMMANDS) {
    lines.push(`  ${cmd.padEnd(12)} ${desc}`);
  }
  lines.push("");
  lines.push("key bindings");
  for (const { key, desc } of STARTUP_GUIDE_KEYS) {
    lines.push(`  ${key.padEnd(12)} ${desc}`);
  }
  return lines.join("\n");
}

export function formatHelpMessage(): string {
  const cmds = listSlashCommands()
    .map((c) => `  /${c.name.padEnd(12)} ${c.description}`)
    .join("\n");
  return [
    "Available commands:",
    cmds,
    "",
    "Agent commands (/status, /compact, /skills, …) run through goose.",
    "Recipe and skill slash commands are also supported when configured.",
    "",
    "Autocomplete:",
    "  Type / then Tab or ↑↓ to complete a command name.",
    "",
    "Navigation:",
    "  Enter            Send message",
    "  Ctrl+Enter       Newline",
    "  Tab              Complete /command",
    "  Ctrl+P / Ctrl+M  Provider / model",
    "  Ctrl+E           Extensions",
    "  ↑↓ / ⌥↑↓         Scroll / fast scroll",
    "  Shift+↑↓         Previous / next turn",
    "  Esc / Ctrl+C     Exit",
  ].join("\n");
}

const helpCommand: SlashCommand = {
  name: "help",
  description: "show all commands",
  guide: true,
  run: () => ({ handled: true, message: formatHelpMessage() }),
};

const exitCommand: SlashCommand = {
  name: "exit",
  description: "quit session",
  guide: true,
  run: () => ({ handled: true, action: "exit" }),
};

const quitCommand: SlashCommand = {
  name: "quit",
  description: "quit session",
  run: () => ({ handled: true, action: "exit" }),
};

const diffCommand: SlashCommand = {
  name: "diff",
  description: "show unstaged changes",
  guide: true,
  run: (ctx) => {
    if (!isGitRepo(ctx.cwd)) {
      return {
        handled: true,
        message: `not a git repository: ${ctx.cwd}`,
      };
    }

    const diff = readDiff(ctx.cwd);
    if (diff === null) {
      return { handled: true, message: "failed to run `git diff`" };
    }

    if (diff.text.trim().length === 0) {
      return { handled: true, message: "no unstaged changes" };
    }

    return {
      handled: true,
      overlay: "diff",
      content: diff.text,
      truncated: diff.truncated,
    };
  },
};

const modelCommand: SlashCommand = {
  name: "model",
  description: "open model picker",
  guide: true,
  run: () => ({ handled: true, overlay: "configure", intent: "model" }),
};

const providerCommand: SlashCommand = {
  name: "provider",
  description: "open provider picker",
  run: () => ({ handled: true, overlay: "configure", intent: "provider" }),
};

const extensionsCommand: SlashCommand = {
  name: "extensions",
  description: "open extensions manager",
  run: () => ({ handled: true, overlay: "extensions" }),
};

const clearCommand: SlashCommand = {
  name: "clear",
  description: "clear chat history",
  guide: true,
  run: () => ({
    handled: true,
    action: "clear",
    message: "Conversation cleared",
  }),
};

/** Agent-passthrough stubs so they appear in /help and the command table. */
function agentPassthrough(name: string, description: string): SlashCommand {
  return {
    name,
    description,
    guide: ["status", "compact", "skills"].includes(name),
    run: (_ctx, args) => ({
      handled: true,
      action: "agent",
      text: args ? `/${name} ${args}` : `/${name}`,
    }),
  };
}

const COMMANDS: Record<string, SlashCommand> = {
  help: helpCommand,
  "?": helpCommand,
  exit: exitCommand,
  quit: quitCommand,
  diff: diffCommand,
  model: modelCommand,
  provider: providerCommand,
  extensions: extensionsCommand,
  clear: clearCommand,
  status: agentPassthrough("status", "show session status"),
  compact: agentPassthrough("compact", "compact conversation context"),
  summarize: agentPassthrough("summarize", "alias for /compact"),
  skills: agentPassthrough("skills", "list or enable skills"),
  prompts: agentPassthrough("prompts", "list available prompts"),
  prompt: agentPassthrough("prompt", "run a prompt by name"),
  doctor: agentPassthrough("doctor", "check goose setup"),
  goal: agentPassthrough("goal", "set or clear session goal"),
  grind: agentPassthrough("grind", "set or clear grind goal"),
};

export function tryRunSlashCommand(
  input: string,
  ctx: SlashCommandContext,
): SlashCommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { handled: false };

  const withoutSlash = trimmed.slice(1);
  const spaceIdx = withoutSlash.search(/\s/);
  const name =
    (spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)).toLowerCase();
  const args =
    spaceIdx === -1 ? "" : withoutSlash.slice(spaceIdx + 1).trim();

  if (!name) return { handled: false };

  const cmd = COMMANDS[name];
  if (cmd) return cmd.run(ctx, args);

  // Unknown /command → send to agent (recipe / skill slash commands).
  if (AGENT_COMMANDS.has(name) || name.length > 0) {
    return { handled: true, action: "agent", text: trimmed };
  }

  return { handled: false };
}

export function listSlashCommands(): SlashCommand[] {
  // Deduplicate aliases (help/? share the same object).
  const seen = new Set<SlashCommand>();
  const out: SlashCommand[] = [];
  for (const cmd of Object.values(COMMANDS)) {
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    out.push(cmd);
  }
  return out;
}

export function isSlashCommandInput(input: string): boolean {
  return input.trim().startsWith("/");
}

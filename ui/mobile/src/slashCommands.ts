/**
 * Slash commands for the mobile PWA client.
 *
 * "Splash" commands are the subset shown on the empty-state startup guide,
 * aligned with CLI/TUI session startup. Agent-handled commands are sent as
 * ACP prompts; local-only commands (help, clear UI, exit) run on the client.
 */

import {
  sessionDisplayName,
  sessionMessageLabel,
  type SavedSession,
} from "./sessions.ts";

export type { SavedSession };

export type SlashCommandResult =
  | { handled: true; message?: string }
  | { handled: true; action: "exit" }
  | { handled: true; action: "clear"; message: string }
  | { handled: true; action: "agent"; text: string }
  | { handled: true; action: "resume"; target: string }
  | { handled: true; action: "sessions" }
  | { handled: false };

export interface SlashCommand {
  name: string;
  description: string;
  /** Shown on the empty-state splash guide. */
  guide?: boolean;
  run: (args: string) => SlashCommandResult;
}

/** Commands shown on the session startup splash (mobile-appropriate subset). */
export const STARTUP_GUIDE_COMMANDS: ReadonlyArray<{
  cmd: string;
  desc: string;
}> = [
  { cmd: "/help", desc: "show all commands" },
  { cmd: "/sessions", desc: "browse saved sessions" },
  { cmd: "/status", desc: "model, provider, mode, tokens" },
  { cmd: "/compact", desc: "shrink conversation context" },
  { cmd: "/skills", desc: "list or enable skills" },
  { cmd: "/clear", desc: "clear chat history" },
  { cmd: "/exit", desc: "disconnect" },
];

/** Max suggestions shown in the composer autocomplete popup. */
export const SLASH_AUTOCOMPLETE_MAX = 8;

export type SlashSuggestionKind = "command" | "session";

export interface SlashSuggestion {
  name: string;
  description: string;
  /** Completed input text including leading `/` and trailing space. */
  completion: string;
  kind?: SlashSuggestionKind;
}

const RESUME_CMD = "/resume";

/** Extra agent commands listed in help/autocomplete (sent as ACP prompts). */
const AGENT_COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "status", description: "show session status" },
  { name: "compact", description: "compact conversation context" },
  { name: "summarize", description: "alias for /compact" },
  { name: "skills", description: "list or enable skills" },
  { name: "prompts", description: "list available prompts" },
  { name: "prompt", description: "run a prompt by name" },
  { name: "doctor", description: "check goose setup" },
  { name: "goal", description: "set or clear session goal" },
  { name: "grind", description: "set or clear grind goal" },
];

const AGENT_COMMAND_NAMES = new Set(AGENT_COMMANDS.map((c) => c.name));

function agentPassthrough(name: string, description: string): SlashCommand {
  return {
    name,
    description,
    guide: ["status", "compact", "skills"].includes(name),
    run: (args) => ({
      handled: true,
      action: "agent",
      text: args ? `/${name} ${args}` : `/${name}`,
    }),
  };
}

function formatHelpMessage(): string {
  const cmds = listSlashCommands()
    .map((c) => `  /${c.name.padEnd(12)} ${c.description}`)
    .join("\n");
  return [
    "Available commands:",
    cmds,
    "",
    "Agent commands (/status, /compact, /skills, …) run on the remote host.",
    "Recipe and skill slash commands are also supported when configured.",
    "",
    "Type / for suggestions. /sessions opens saved chats; after /resume,",
    "saved sessions are offered. Tap a splash command to run it.",
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
  description: "disconnect from the remote agent",
  guide: true,
  run: () => ({ handled: true, action: "exit" }),
};

const quitCommand: SlashCommand = {
  name: "quit",
  description: "disconnect from the remote agent",
  run: () => ({ handled: true, action: "exit" }),
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

const resumeCommand: SlashCommand = {
  name: "resume",
  description: "list or resume a saved session",
  run: (args) => {
    const target = args.trim().split(/\s+/).find(Boolean) ?? "";
    if (!target) {
      return { handled: true, action: "sessions" };
    }
    return { handled: true, action: "resume", target };
  },
};

const sessionsCommand: SlashCommand = {
  name: "sessions",
  description: "browse saved sessions",
  guide: true,
  run: () => ({ handled: true, action: "sessions" }),
};

const COMMANDS: Record<string, SlashCommand> = {
  help: helpCommand,
  "?": helpCommand,
  exit: exitCommand,
  quit: quitCommand,
  clear: clearCommand,
  resume: resumeCommand,
  sessions: sessionsCommand,
  ...Object.fromEntries(
    AGENT_COMMANDS.map((c) => [c.name, agentPassthrough(c.name, c.description)]),
  ),
};

export function listSlashCommands(): SlashCommand[] {
  const seen = new Set<SlashCommand>();
  const out: SlashCommand[] = [];
  for (const cmd of Object.values(COMMANDS)) {
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    out.push(cmd);
  }
  return out;
}

export interface MatchSlashCommandsOptions {
  sessions?: readonly SavedSession[];
  currentSessionId?: string | null;
}

/**
 * Typed `/resume` argument prefix, or null when the input is not completing
 * a resume target (command name still being typed, or a second token).
 */
export function resumeArgPrefix(input: string): string | null {
  const trimmed = input.trimStart();
  if (!trimmed.toLowerCase().startsWith(RESUME_CMD)) return null;
  const rest = trimmed.slice(RESUME_CMD.length);
  if (rest.length === 0 || !rest.startsWith(" ")) return null;
  const partial = rest.trimStart();
  if (/\s/.test(partial)) return null;
  return partial;
}

export function isResumeArgInput(input: string): boolean {
  return resumeArgPrefix(input) !== null;
}

function sessionReplacement(session: SavedSession, partialLower: string): string {
  if (
    session.name.trim() &&
    session.name.toLowerCase().startsWith(partialLower)
  ) {
    return `${session.name} `;
  }
  return `${session.id} `;
}

/**
 * Complete saved session names/ids for `/resume`.
 *
 * Offers sessions with messages (excluding the current session when known).
 * Matches the typed prefix against session name or id; replacement prefers
 * a unique non-empty name, otherwise the session id.
 */
export function matchResumeSessions(
  input: string,
  sessions: readonly SavedSession[],
  currentSessionId?: string | null,
): SlashSuggestion[] {
  const partial = resumeArgPrefix(input);
  if (partial === null) return [];

  const partialLower = partial.toLowerCase();
  const candidates: SlashSuggestion[] = [];
  const seen = new Set<string>();

  for (const session of sessions) {
    if (currentSessionId && session.id === currentSessionId) continue;
    if (session.messageCount <= 0) continue;

    const name = sessionDisplayName(session);
    if (
      !session.name.toLowerCase().startsWith(partialLower) &&
      !session.id.toLowerCase().startsWith(partialLower)
    ) {
      continue;
    }

    const replacement = sessionReplacement(session, partialLower);
    if (seen.has(replacement)) continue;
    seen.add(replacement);

    candidates.push({
      name,
      description: `${sessionMessageLabel(session.messageCount)} · ${session.id}`,
      completion: `${RESUME_CMD} ${replacement}`,
      kind: "session",
    });
  }

  candidates.sort((a, b) => a.name.localeCompare(b.name));
  return candidates;
}

/**
 * Match slash-command completions for the current input.
 *
 * Completes command names while the first token is partial. After
 * `/resume `, completes saved session names/ids when `sessions` is provided.
 */
export function matchSlashCommands(
  input: string,
  options: MatchSlashCommandsOptions = {},
): SlashSuggestion[] {
  if (isResumeArgInput(input)) {
    return matchResumeSessions(
      input,
      options.sessions ?? [],
      options.currentSessionId,
    );
  }

  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return [];
  if (/\s/.test(trimmed.slice(1))) return [];

  const prefix = trimmed.slice(1).toLowerCase();
  return listSlashCommands()
    .filter((cmd) => cmd.name !== "?" && cmd.name.startsWith(prefix))
    .sort((a, b) => {
      // Splash-guide order first, then alpha.
      const guideRank = (name: string) => {
        const idx = STARTUP_GUIDE_COMMANDS.findIndex(
          (g) => g.cmd === `/${name}`,
        );
        return idx === -1 ? STARTUP_GUIDE_COMMANDS.length : idx;
      };
      return (
        guideRank(a.name) - guideRank(b.name) || a.name.localeCompare(b.name)
      );
    })
    .map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      completion: `/${cmd.name} `,
      kind: "command" as const,
    }));
}

export function tryRunSlashCommand(input: string): SlashCommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { handled: false };

  const withoutSlash = trimmed.slice(1);
  const spaceIdx = withoutSlash.search(/\s/);
  const name = (
    spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)
  ).toLowerCase();
  const args = spaceIdx === -1 ? "" : withoutSlash.slice(spaceIdx + 1).trim();

  if (!name) return { handled: false };

  const cmd = COMMANDS[name];
  if (cmd) return cmd.run(args);

  // Unknown /command → send to agent (recipe / skill slash commands).
  if (AGENT_COMMAND_NAMES.has(name) || name.length > 0) {
    return { handled: true, action: "agent", text: trimmed };
  }

  return { handled: false };
}

export function isSlashCommandInput(input: string): boolean {
  return input.trim().startsWith("/");
}

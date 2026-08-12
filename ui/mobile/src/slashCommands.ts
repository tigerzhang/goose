/**
 * Slash commands for the mobile PWA client.
 *
 * "Splash" commands are the subset shown on the empty-state startup guide,
 * aligned with CLI/TUI session startup. Agent-handled commands are sent as
 * ACP prompts; local-only commands (help, clear UI, exit) run on the client.
 */

export type SlashCommandResult =
  | { handled: true; message?: string }
  | { handled: true; action: "exit" }
  | { handled: true; action: "clear"; message: string }
  | { handled: true; action: "agent"; text: string }
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
  { cmd: "/status", desc: "model, provider, mode, tokens" },
  { cmd: "/compact", desc: "shrink conversation context" },
  { cmd: "/skills", desc: "list or enable skills" },
  { cmd: "/clear", desc: "clear chat history" },
  { cmd: "/exit", desc: "disconnect" },
];

/** Max suggestions shown in the composer autocomplete popup. */
export const SLASH_AUTOCOMPLETE_MAX = 8;

export interface SlashSuggestion {
  name: string;
  description: string;
  /** Completed input text including leading `/` and trailing space. */
  completion: string;
}

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
  { name: "resume", description: "list or resume a saved session" },
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
    "Type / for suggestions. Tap a splash command to run it.",
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

const COMMANDS: Record<string, SlashCommand> = {
  help: helpCommand,
  "?": helpCommand,
  exit: exitCommand,
  quit: quitCommand,
  clear: clearCommand,
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

/**
 * Match slash-command completions for the current input.
 * Only active while the first token is a partial command (no args yet).
 */
export function matchSlashCommands(input: string): SlashSuggestion[] {
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

use goose::agents::execute_commands::list_commands;
use goose::config::GooseMode;
use rustyline::completion::{Completer, FilenameCompleter, Pair};
use rustyline::highlight::{CmdKind, Highlighter};
use rustyline::hint::Hinter;
use rustyline::validate::Validator;
use rustyline::{Cmd, ConditionalEventHandler, Context, Event, EventContext, Helper, Result};
use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use strum::VariantNames;

use super::{CompletionCache, HintStatus};

/// CLI-local slash commands (name + tip-menu description), not in `list_commands()`.
const CLI_SLASH_COMMANDS: &[(&str, &str)] = &[
    ("/exit", "quit session"),
    ("/quit", "quit session"),
    ("/help", "show all commands"),
    ("/?", "show all commands"),
    ("/t", "toggle theme"),
    ("/r", "toggle full tool output"),
    ("/extension", "add a stdio extension"),
    ("/builtin", "add builtin extensions by name"),
    ("/mode", "set goose mode (auto, approve, chat, …)"),
    ("/model", "show or switch model"),
    ("/plan", "enter plan mode"),
    ("/endplan", "exit plan mode"),
    ("/recipe", "save conversation as a recipe"),
    ("/edit", "open prompt editor"),
];

/// Splash-guide order: shown first in the tip menu.
const SPLASH_SLASH_ORDER: &[&str] = &[
    "/help", "/status", "/model", "/mode", "/plan", "/compact", "/skills", "/clear", "/exit",
];

/// All slash-command entries (name with leading `/`, description) for autocomplete / tip menu.
pub(crate) fn slash_command_entries() -> Vec<(String, String)> {
    let mut commands: Vec<(String, String)> = CLI_SLASH_COMMANDS
        .iter()
        .map(|(name, desc)| ((*name).to_string(), (*desc).to_string()))
        .collect();
    for command in list_commands() {
        let name = format!("/{}", command.name);
        if !commands.iter().any(|(n, _)| n == &name) {
            commands.push((name, command.description.to_string()));
        }
    }
    commands.sort_by(|a, b| {
        let rank = |name: &str| {
            SPLASH_SLASH_ORDER
                .iter()
                .position(|s| *s == name)
                .unwrap_or(usize::MAX)
        };
        rank(&a.0).cmp(&rank(&b.0)).then_with(|| a.0.cmp(&b.0))
    });
    commands
}

/// Slash commands whose name starts with `prefix` (e.g. `/`, `/pl`, `/ex`).
pub(crate) fn matching_slash_commands(prefix: &str) -> Vec<(String, String)> {
    slash_command_entries()
        .into_iter()
        .filter(|(name, _)| name.starts_with(prefix))
        .collect()
}

/// True while the line is still naming a slash command (no args yet).
pub(crate) fn is_slash_command_name_input(line: &str, pos: usize) -> bool {
    if pos < line.len() {
        return false;
    }
    let trimmed = line.trim_end();
    if trimmed.is_empty() {
        // Empty prompt: Tab opens the full command menu.
        return true;
    }
    trimmed.starts_with('/') && !trimmed[1..].contains(' ') && !trimmed[1..].contains('\t')
}

/// Advance (or reverse) a menu cursor with wrap-around. Pure helper for tests + UI.
pub(crate) fn cycle_menu_index(len: usize, idx: usize, forward: bool) -> usize {
    if len == 0 {
        return 0;
    }
    let idx = idx.min(len - 1);
    if forward {
        (idx + 1) % len
    } else if idx == 0 {
        len - 1
    } else {
        idx - 1
    }
}

/// Interactive tip menu for slash commands matching `prefix`.
///
/// Must run **outside** rustyline raw mode (after readline returns). Nested
/// menus during Tab mid-line fail because rustyline holds raw mode.
///
/// Keys inside the menu:
/// - **Tab** / ↓ / j — next option (wrap)
/// - **Shift+Tab** / ↑ / k — previous option
/// - **Enter** — confirm selection into the input line (**does not execute**)
/// - **Esc** — cancel
///
/// Returns the chosen command name (e.g. `"/help"`), or `None` if canceled / no matches.
/// The caller must only complete the prompt with this value — not run the command until
/// the user presses Enter on the main prompt.
pub(crate) fn prompt_slash_command_tip_menu(prefix: &str) -> Option<String> {
    let prefix = if prefix.is_empty() { "/" } else { prefix };
    let matching = matching_slash_commands(prefix);
    if matching.is_empty() {
        return None;
    }
    if matching.len() == 1 {
        return Some(matching[0].0.clone());
    }

    run_slash_tip_menu(&matching)
}

/// Render and drive the tip menu. Stock `cliclack::select` ignores Tab, so this
/// uses `console::Term` with Tab-to-cycle semantics.
fn run_slash_tip_menu(items: &[(String, String)]) -> Option<String> {
    use console::{style, Key, Term};
    use std::io::Write;

    let mut term = Term::stderr();
    if !term.is_term() {
        return None;
    }

    let n = items.len();
    let mut cursor = 0usize;
    let header = "Slash commands (Tab cycle, Enter complete, Esc cancel):";
    // header + blank + n rows
    let frame_lines = n + 2;
    let mut first_frame = true;

    loop {
        if !first_frame {
            let _ = term.clear_last_lines(frame_lines);
        }
        first_frame = false;

        let mut frame = String::new();
        frame.push_str(&format!("{}\n\n", style(header).dim()));
        let name_width = items
            .iter()
            .map(|(name, _)| name.chars().count())
            .max()
            .unwrap_or(0);
        for (i, (name, desc)) in items.iter().enumerate() {
            if i == cursor {
                frame.push_str(&format!(
                    "  {} {:name_width$}  {}\n",
                    style("›").cyan().bold(),
                    style(name.as_str()).cyan().bold(),
                    style(desc.as_str()).white(),
                ));
            } else {
                frame.push_str(&format!(
                    "    {:name_width$}  {}\n",
                    style(name.as_str()).dim(),
                    style(desc.as_str()).dim(),
                ));
            }
        }
        let _ = term.write_all(frame.as_bytes());
        let _ = term.flush();

        let key = match term.read_key() {
            Ok(k) => k,
            Err(_) => {
                let _ = term.clear_last_lines(frame_lines);
                return None;
            }
        };

        match key {
            Key::Tab | Key::ArrowDown | Key::Char('j') | Key::Char('l') => {
                cursor = cycle_menu_index(n, cursor, true);
            }
            Key::BackTab | Key::ArrowUp | Key::Char('k') | Key::Char('h') => {
                cursor = cycle_menu_index(n, cursor, false);
            }
            Key::Enter => {
                let _ = term.clear_last_lines(frame_lines);
                return Some(items[cursor].0.clone());
            }
            Key::Escape => {
                let _ = term.clear_last_lines(frame_lines);
                return None;
            }
            // Ignore other keys (including printable) so typing doesn't glitch the menu.
            _ => {}
        }
    }
}

/// Tab: end readline and request the slash-command tip menu.
///
/// Must not open the menu mid-readline (raw mode). The menu runs in
/// [`crate::session::input::get_input`] after AcceptLine releases the terminal.
pub(crate) struct SlashCommandMenuHandler {
    pub(crate) pending_prefix: Arc<Mutex<Option<String>>>,
}

impl SlashCommandMenuHandler {
    pub(crate) fn new(pending_prefix: Arc<Mutex<Option<String>>>) -> Self {
        Self { pending_prefix }
    }
}

impl ConditionalEventHandler for SlashCommandMenuHandler {
    fn handle(&self, _evt: &Event, _n: u16, _positive: bool, ctx: &EventContext) -> Option<Cmd> {
        let line = ctx.line();
        let pos = ctx.pos();
        if !is_slash_command_name_input(line, pos) {
            return None;
        }

        let prefix = {
            let t = line.trim_end();
            if t.is_empty() {
                "/".to_string()
            } else {
                t.to_string()
            }
        };
        if let Ok(mut guard) = self.pending_prefix.lock() {
            *guard = Some(prefix);
        }
        Some(Cmd::AcceptLine)
    }
}

/// Completer for goose CLI commands
pub struct GooseCompleter {
    pub completion_cache: Arc<std::sync::RwLock<CompletionCache>>,
    filename_completer: FilenameCompleter,
}

impl GooseCompleter {
    /// Create a new GooseCompleter with a reference to the Session's completion cache
    pub fn new(completion_cache: Arc<std::sync::RwLock<CompletionCache>>) -> Self {
        Self {
            completion_cache,
            filename_completer: FilenameCompleter::new(),
        }
    }

    /// Complete prompt names for the /prompt command
    fn complete_prompt_names(&self, line: &str) -> Result<(usize, Vec<Pair>)> {
        // Get the prefix of the prompt name being typed
        let prefix = line.get(8..).unwrap_or("");

        // Get available prompts from cache
        let cache = self.completion_cache.read().unwrap();

        // Create completion candidates that match the prefix
        let candidates: Vec<Pair> = cache
            .prompts
            .values()
            .flatten()
            .filter(|name| name.starts_with(prefix.trim()))
            .map(|name| Pair {
                display: name.clone(),
                replacement: name.clone(),
            })
            .collect();

        Ok((8, candidates))
    }

    /// Complete flags for the /prompt command
    fn complete_prompt_flags(&self, line: &str) -> Result<(usize, Vec<Pair>)> {
        // Get the last part of the line
        let parts: Vec<&str> = line.split_whitespace().collect();
        if let Some(last_part) = parts.last() {
            // If the last part starts with '-', it might be a partial flag
            if last_part.starts_with('-') {
                // Define available flags
                let flags = ["--info"];

                // Find flags that match the prefix
                let matching_flags: Vec<Pair> = flags
                    .iter()
                    .filter(|flag| flag.starts_with(last_part))
                    .map(|flag| Pair {
                        display: flag.to_string(),
                        replacement: flag.to_string(),
                    })
                    .collect();

                if !matching_flags.is_empty() {
                    // Return matches for the partial flag
                    // The position is the start of the last word
                    let pos = line.len() - last_part.len();
                    return Ok((pos, matching_flags));
                }
            }
        }

        // No flag completions available
        Ok((line.len(), vec![]))
    }

    /// Complete flags for the /mode command
    fn complete_mode_flags(&self, line: &str) -> Result<(usize, Vec<Pair>)> {
        let modes = GooseMode::VARIANTS;

        let parts: Vec<&str> = line.split_whitespace().collect();

        // If we're just after "/mode" with a space, show all options
        if line == "/mode " {
            return Ok((
                line.len(),
                modes
                    .iter()
                    .map(|mode| Pair {
                        display: mode.to_string(),
                        replacement: format!("{} ", mode),
                    })
                    .collect(),
            ));
        }

        // If we're typing a mode name, show the flags for that mode
        if parts.len() == 2 {
            let partial = parts[1].to_lowercase();
            return Ok((
                line.len() - partial.len(),
                modes
                    .iter()
                    .filter(|mode| mode.to_lowercase().starts_with(&partial.to_lowercase()))
                    .map(|mode| Pair {
                        display: mode.to_string(),
                        replacement: format!("{} ", mode),
                    })
                    .collect(),
            ));
        }

        // No completions available
        Ok((line.len(), vec![]))
    }

    /// Complete skill names for the /skills command
    fn complete_skill_names(&self, line: &str) -> Result<(usize, Vec<Pair>)> {
        use goose::skills::list_installed_skills;

        let cwd = std::env::current_dir().unwrap_or_default();
        let skills = list_installed_skills(Some(&cwd));
        let skill_names: Vec<String> = skills.iter().map(|s| s.name.clone()).collect();

        let last = line.rsplit_once(' ').map_or("", |(_, w)| w);
        let pos = line.len() - last.len();

        let partial = last.to_lowercase();
        let candidates: Vec<Pair> = skill_names
            .iter()
            .filter(|name| name.to_lowercase().starts_with(&partial))
            .map(|name| Pair {
                display: name.clone(),
                replacement: format!("{} ", name),
            })
            .collect();

        Ok((pos, candidates))
    }

    /// Complete model names for the /model command.
    fn complete_model_names(&self, line: &str) -> Result<(usize, Vec<Pair>)> {
        Ok((line.len(), vec![]))
    }

    /// Complete saved session names/ids for the `/resume` command.
    ///
    /// Offers sessions with messages (excluding the current session when known).
    /// Matches the typed prefix against session name or id; replacement prefers
    /// a unique non-empty name, otherwise the session id.
    fn complete_resume_sessions(&self, line: &str) -> Result<(usize, Vec<Pair>)> {
        const CMD: &str = "/resume";
        if !line.starts_with(CMD) {
            return Ok((line.len(), vec![]));
        }

        // Only complete the first argument after `/resume`.
        let rest = line.get(CMD.len()..).unwrap_or("");
        if !rest.is_empty() && !rest.starts_with(' ') {
            // e.g. "/resumex" — not our command
            return Ok((line.len(), vec![]));
        }

        let partial = rest.trim_start();
        // Do not complete past a second token.
        if partial.contains(char::is_whitespace) {
            return Ok((line.len(), vec![]));
        }

        let pos = line.len() - partial.len();
        let partial_lower = partial.to_lowercase();

        let cache = self.completion_cache.read().unwrap();
        let mut candidates: Vec<Pair> = cache
            .resume_sessions
            .iter()
            .filter(|entry| !entry.is_current && entry.message_count > 0)
            .filter(|entry| {
                entry.name.to_lowercase().starts_with(&partial_lower)
                    || entry.session_id.to_lowercase().starts_with(&partial_lower)
            })
            .map(|entry| {
                let name = if entry.name.is_empty() {
                    "(unnamed)"
                } else {
                    entry.name.as_str()
                };
                let msgs = if entry.message_count == 1 {
                    "1 msg".to_string()
                } else {
                    format!("{} msgs", entry.message_count)
                };
                // Prefer completing to name when the user is typing a name match;
                // otherwise use the stable session id.
                let replacement = if !entry.name.is_empty()
                    && entry.name.to_lowercase().starts_with(&partial_lower)
                {
                    format!("{} ", entry.name)
                } else {
                    format!("{} ", entry.session_id)
                };
                Pair {
                    display: format!("{name}  ({msgs})  [{}]", entry.session_id),
                    replacement,
                }
            })
            .collect();

        // Stable order: by display text
        candidates.sort_by(|a, b| a.display.cmp(&b.display));
        candidates.dedup_by(|a, b| a.replacement == b.replacement);

        Ok((pos, candidates))
    }

    /// Complete slash commands via Tab circular completion.
    ///
    /// First Tab inserts the first match; each further Tab cycles to the next.
    /// Enter is not involved — the user presses Enter later to run the line.
    fn complete_slash_commands(&self, line: &str) -> Result<(usize, Vec<Pair>)> {
        let prefix = line.trim_end();
        let matching = matching_slash_commands(prefix);

        if matching.is_empty() {
            return Ok((line.len(), vec![]));
        }

        // Exact full command already on the line (e.g. after a prior Tab): rotate
        // so the *next* Tab advances to the following command in the full list.
        let matching = if matching.len() == 1 && matching[0].0 == prefix {
            let all = slash_command_entries();
            if let Some(idx) = all.iter().position(|(n, _)| n == prefix) {
                let mut rotated = Vec::with_capacity(all.len());
                rotated.extend_from_slice(&all[idx + 1..]);
                rotated.extend_from_slice(&all[..=idx]);
                rotated
            } else {
                matching
            }
        } else {
            matching
        };

        // `replacement` is what circular Tab writes into the line (trailing space
        // so arg-taking commands are ready to type).
        let matching_commands: Vec<Pair> = matching
            .iter()
            .map(|(name, desc)| Pair {
                display: format!("{name}  {desc}"),
                replacement: format!("{name} "),
            })
            .collect();

        // Position 0: replace from the leading `/` of the command.
        Ok((0, matching_commands))
    }

    /// Complete argument keys for a specific prompt
    fn complete_argument_keys(&self, line: &str) -> Result<(usize, Vec<Pair>)> {
        let parts: Vec<&str> = line.get(8..).unwrap_or("").split_whitespace().collect();

        // We need at least the prompt name
        if parts.is_empty() {
            return Ok((line.len(), vec![]));
        }

        let prompt_name = parts[0];

        // Get prompt info from cache
        let cache = self.completion_cache.read().unwrap();
        let prompt_info = cache.prompt_info.get(prompt_name).cloned();

        if let Some(info) = prompt_info {
            if let Some(args) = info.arguments {
                // Find required arguments that haven't been provided yet
                let existing_args: Vec<&str> = parts
                    .iter()
                    .skip(1)
                    .filter_map(|part| {
                        if part.contains('=') {
                            Some(part.split('=').next().unwrap())
                        } else {
                            None
                        }
                    })
                    .collect();

                // Check if we're trying to complete a partial argument name
                if let Some(last_part) = parts.last() {
                    // ignore if last_part starts with = / \ for suggestions
                    if let Some(c) = last_part.chars().next() {
                        if matches!(c, '=' | '/' | '\\') {
                            return Ok((line.len(), vec![]));
                        }
                    }

                    // If the last part doesn't contain '=', it might be a partial argument name
                    if !last_part.contains('=') {
                        // Find arguments that match the prefix
                        let matching_args: Vec<Pair> = args
                            .iter()
                            .filter(|arg| {
                                arg.name.starts_with(last_part)
                                    && !existing_args.contains(&arg.name.as_str())
                            })
                            .map(|arg| Pair {
                                display: format!("{}=", arg.name),
                                replacement: format!("{}=", arg.name),
                            })
                            .collect();

                        if !matching_args.is_empty() {
                            // Return matches for the partial argument name
                            // The position is the start of the last word
                            let pos = line.len() - last_part.len();
                            return Ok((pos, matching_args));
                        }

                        // If we have a partial argument that doesn't match anything,
                        // return an empty list rather than suggesting unrelated arguments
                        if !last_part.is_empty() && *last_part != prompt_name {
                            return Ok((line.len(), vec![]));
                        }
                    }
                }

                // If no partial match or no last part, suggest all required arguments
                // Use a reference to avoid moving args
                let mut candidates: Vec<_> = Vec::new();
                for arg in &args {
                    if arg.required.unwrap_or(false) && !existing_args.contains(&arg.name.as_str())
                    {
                        candidates.push(Pair {
                            display: format!("{}=", arg.name),
                            replacement: format!("{}=", arg.name),
                        });
                    }
                }

                if !candidates.is_empty() {
                    return Ok((line.len(), candidates));
                }

                // If no required arguments left, suggest all optional ones
                // Use a reference to avoid moving args
                for arg in &args {
                    if !arg.required.unwrap_or(true) && !existing_args.contains(&arg.name.as_str())
                    {
                        candidates.push(Pair {
                            display: format!("{}=", arg.name),
                            replacement: format!("{}=", arg.name),
                        });
                    }
                }
                return Ok((line.len(), candidates));
            }
        }

        // No completions available
        Ok((line.len(), vec![]))
    }

    /// Complete file paths
    fn complete_file_path(&self, line: &str, ctx: &Context) -> Result<(usize, Vec<Pair>)> {
        let parts: Vec<&str> = line.split_whitespace().collect();

        if let Some(last_part) = parts.last() {
            // Skip filename completion for words starting with special characters
            if last_part.starts_with('/') && last_part.len() == 1 {
                // Just a slash - no completion
                return Ok((line.len(), vec![]));
            }

            if last_part.starts_with('-') || last_part.contains('=') {
                // Skip flag or key-value pairs
                return Ok((line.len(), vec![]));
            }

            // Complete the partial path
            let pos = line.len() - last_part.len();
            let (start, candidates) =
                self.filename_completer
                    .complete(last_part, last_part.len(), ctx)?;

            // Return the completion results, with adjusted position
            return Ok((pos + start, candidates));
        }

        Ok((line.len(), vec![]))
    }
}

impl Completer for GooseCompleter {
    type Candidate = Pair;

    fn complete(
        &self,
        line: &str,
        pos: usize,
        ctx: &Context<'_>,
    ) -> Result<(usize, Vec<Self::Candidate>)> {
        // If the cursor is not at the end of the line, don't try to complete
        if pos < line.len() {
            return Ok((pos, vec![]));
        }

        // If the line starts with '/', it might be a slash command
        if line.starts_with('/') {
            // If it's just a partial slash command (no space yet)
            if !line.contains(' ') {
                return self.complete_slash_commands(line);
            }

            // Handle /prompt command
            if line.starts_with("/prompt") {
                // If we're just after "/prompt" with or without a space
                if line == "/prompt" || line == "/prompt " {
                    return self.complete_prompt_names(line);
                }

                // Get the parts of the command
                let parts: Vec<&str> = line.split_whitespace().collect();

                // If we're typing a prompt name (only one part after /prompt)
                if parts.len() == 2 && !line.ends_with(' ') {
                    return self.complete_prompt_names(line);
                }

                // Check if we might be typing a flag
                if let Some(last_part) = parts.last() {
                    if last_part.starts_with('-') {
                        return self.complete_prompt_flags(line);
                    }
                }

                // If we have a prompt name and need argument completion
                if parts.len() >= 2 {
                    return self.complete_argument_keys(line);
                }
            }

            // Handle /prompts command
            if line.starts_with("/prompts") {
                // If we're just after "/prompts" with a space
                if line == "/prompts " {
                    // Suggest the --extension flag
                    return Ok((
                        line.len(),
                        vec![Pair {
                            display: "--extension".to_string(),
                            replacement: "--extension ".to_string(),
                        }],
                    ));
                }

                // Check if we might be typing the --extension flag
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() == 2
                    && parts[1].starts_with('-')
                    && "--extension".starts_with(parts[1])
                {
                    return Ok((
                        line.len() - parts[1].len(),
                        vec![Pair {
                            display: "--extension".to_string(),
                            replacement: "--extension ".to_string(),
                        }],
                    ));
                }
            }

            if line.starts_with("/model") {
                return self.complete_model_names(line);
            }

            if line.starts_with("/mode") {
                return self.complete_mode_flags(line);
            }

            if line.starts_with("/skills ") {
                return self.complete_skill_names(line);
            }

            if line.starts_with("/resume") {
                return self.complete_resume_sessions(line);
            }

            return Ok((pos, vec![]));
        }

        // For normal text (not slash commands), try file path completion
        self.complete_file_path(line, ctx)
    }
}

// Implement the Helper trait which is required by rustyline
impl Helper for GooseCompleter {}

// Implement required traits with default implementations
impl Hinter for GooseCompleter {
    type Hint = String;

    fn hint(&self, line: &str, _pos: usize, _ctx: &Context<'_>) -> Option<Self::Hint> {
        let cache = self.completion_cache.read().unwrap();

        if !line.is_empty() && cache.hint_status != HintStatus::Default {
            drop(cache);
            let mut cache_write = self.completion_cache.write().unwrap();
            cache_write.hint_status = HintStatus::Default;
            return None;
        }

        // While typing a slash command name, show which Tab will cycle to next.
        if line.starts_with('/') && !line[1..].contains(' ') {
            let matches = matching_slash_commands(line);
            if matches.is_empty() {
                return None;
            }
            let current = line.trim_end();
            // Exact full command after a Tab complete: cycle among all commands.
            let cycle = if matches.len() == 1 && matches[0].0 == current {
                slash_command_entries()
            } else {
                matches
            };
            let idx = cycle.iter().position(|(n, _)| n == current);
            let next = match idx {
                Some(i) => &cycle[(i + 1) % cycle.len()].0,
                None => &cycle[0].0,
            };
            return Some(format!(" Tab · complete via menu ({next}…)"));
        }

        if !line.is_empty() {
            return None;
        }

        match cache.hint_status {
            HintStatus::Interrupted => {
                Some("Interrupted, what should goose work on instead?".to_string())
            }
            HintStatus::MaybeExit => {
                Some("Press Ctrl+C again to exit, or type new instructions to continue".to_string())
            }
            HintStatus::Default => {
                let newline_key = super::input::get_newline_key().to_ascii_uppercase();
                Some(format!(
                    "Enter to send · Tab complete /commands · Ctrl+{newline_key} newline"
                ))
            }
        }
    }
}

impl Highlighter for GooseCompleter {
    fn highlight_prompt<'b, 's: 'b, 'p: 'b>(
        &'s self,
        prompt: &'p str,
        _default: bool,
    ) -> Cow<'b, str> {
        Cow::Borrowed(prompt)
    }

    fn highlight_hint<'h>(&self, hint: &'h str) -> Cow<'h, str> {
        // Style the hint text with a dim color
        let styled = console::Style::new().dim().apply_to(hint).to_string();
        Cow::Owned(styled)
    }

    fn highlight_candidate<'c>(
        &self,
        candidate: &'c str,
        completion: rustyline::config::CompletionType,
    ) -> Cow<'c, str> {
        if completion != rustyline::config::CompletionType::List {
            return Cow::Borrowed(candidate);
        }
        // Tip-menu rows are "{name}  {description}" — cyan name, dim description.
        if let Some((name, rest)) = candidate.split_once("  ") {
            if name.starts_with('/') {
                let styled = format!(
                    "{}{}",
                    console::Style::new().cyan().apply_to(name),
                    console::Style::new().dim().apply_to(format!("  {rest}"))
                );
                return Cow::Owned(styled);
            }
        }
        Cow::Borrowed(candidate)
    }

    fn highlight<'l>(&self, line: &'l str, _pos: usize) -> Cow<'l, str> {
        Cow::Borrowed(line)
    }

    fn highlight_char(&self, _line: &str, _pos: usize, _cmd_kind: CmdKind) -> bool {
        false
    }
}

impl Validator for GooseCompleter {
    fn validate(
        &self,
        _ctx: &mut rustyline::validate::ValidationContext,
    ) -> Result<rustyline::validate::ValidationResult> {
        Ok(rustyline::validate::ValidationResult::Valid(None))
    }
}

#[cfg(test)]
mod tests {
    use rmcp::model::PromptArgument;

    use super::*;
    use crate::session::output;
    use std::sync::{Arc, RwLock};

    // Helper function to create a test completion cache
    fn create_test_cache() -> Arc<RwLock<CompletionCache>> {
        let mut cache = CompletionCache::new();

        // Add some test prompts
        cache.prompts.insert(
            "extension1".to_string(),
            vec!["test_prompt1".to_string(), "test_prompt2".to_string()],
        );

        cache
            .prompts
            .insert("extension2".to_string(), vec!["other_prompt".to_string()]);

        // Add prompt info with arguments
        let test_prompt1_args = vec![
            PromptArgument::new("required_arg")
                .with_description("A required argument")
                .with_required(true),
            PromptArgument::new("optional_arg")
                .with_description("An optional argument")
                .with_required(false),
        ];

        let test_prompt1_info = output::PromptInfo {
            name: "test_prompt1".to_string(),
            description: Some("Test prompt 1 description".to_string()),
            arguments: Some(test_prompt1_args),
            extension: Some("extension1".to_string()),
        };
        cache
            .prompt_info
            .insert("test_prompt1".to_string(), test_prompt1_info);

        let test_prompt2_info = output::PromptInfo {
            name: "test_prompt2".to_string(),
            description: Some("Test prompt 2 description".to_string()),
            arguments: None,
            extension: Some("extension1".to_string()),
        };
        cache
            .prompt_info
            .insert("test_prompt2".to_string(), test_prompt2_info);

        let other_prompt_info = output::PromptInfo {
            name: "other_prompt".to_string(),
            description: Some("Other prompt description".to_string()),
            arguments: None,
            extension: Some("extension2".to_string()),
        };
        cache
            .prompt_info
            .insert("other_prompt".to_string(), other_prompt_info);

        Arc::new(RwLock::new(cache))
    }

    /// Commands shown on the session startup splash/guide (`display_startup_guide`).
    const SPLASH_SLASH_COMMANDS: &[&str] = &[
        "/help", "/status", "/model", "/mode", "/plan", "/compact", "/skills", "/clear", "/exit",
    ];

    /// Other session slash commands handled by the CLI (beyond agent `list_commands()`).
    const CLI_LOCAL_SLASH_COMMANDS: &[&str] = &[
        "/quit",
        "/t",
        "/r",
        "/extension",
        "/builtin",
        "/recipe",
        "/prompts",
        "/prompt",
        "/resume",
        "/endplan",
        "/edit",
        "/?",
    ];

    fn candidate_names(candidates: &[Pair]) -> Vec<&str> {
        candidates
            .iter()
            .map(|c| c.replacement.trim_end())
            .collect()
    }

    fn has_cmd(candidates: &[Pair], cmd: &str) -> bool {
        candidates.iter().any(|c| c.replacement.trim_end() == cmd)
    }

    #[test]
    fn test_complete_slash_commands() {
        let cache = create_test_cache();
        let completer = GooseCompleter::new(cache);

        // Exact full command: Tab advances to the *next* command (circular list).
        let (pos, candidates) = completer.complete_slash_commands("/exit").unwrap();
        assert_eq!(pos, 0);
        assert!(
            candidates.len() > 1,
            "exact match should still offer the full cycle list"
        );
        // /exit is last in splash order; next wraps into the remaining commands.
        assert_ne!(
            candidates[0].replacement.trim_end(),
            "/exit",
            "first Tab on an exact command should move to a different candidate"
        );
        assert!(
            candidates
                .iter()
                .any(|c| c.replacement.trim_end() == "/exit"),
            "cycle list still includes /exit"
        );

        // Test partial match: /ex → /exit and /extension
        let (pos, candidates) = completer.complete_slash_commands("/ex").unwrap();
        assert_eq!(pos, 0);
        let names = candidate_names(&candidates);
        assert!(names.contains(&"/exit"), "got {names:?}");
        assert!(names.contains(&"/extension"), "got {names:?}");
        assert!(
            names.iter().all(|n| n.starts_with("/ex")),
            "all candidates must match prefix, got {names:?}"
        );

        // Partial match: /pl → /plan
        let (pos, candidates) = completer.complete_slash_commands("/pl").unwrap();
        assert_eq!(pos, 0);
        assert!(
            has_cmd(&candidates, "/plan"),
            "partial /pl should yield /plan, got {:?}",
            candidate_names(&candidates)
        );
        assert!(
            candidates
                .iter()
                .any(|c| c.replacement.trim_end() == "/plan" && c.display.contains("plan")),
            "tip menu for /plan should include a description"
        );

        // All candidates under `/` include splash + agent + CLI-local commands
        let (pos, candidates) = completer.complete_slash_commands("/").unwrap();
        assert_eq!(pos, 0);
        assert!(candidates.len() > 1);
        // Completions replace from the start of the command (leading `/`).
        assert!(candidates.iter().all(|c| c.replacement.starts_with('/')));
        // Tip menu rows always include a description column.
        assert!(
            candidates
                .iter()
                .all(|c| c.display.contains("  ") && c.display.starts_with('/')),
            "every tip-menu row should be \"name  description\""
        );

        for cmd in SPLASH_SLASH_COMMANDS {
            assert!(
                has_cmd(&candidates, cmd),
                "splash command {cmd} missing from completer under `/`"
            );
        }
        for command in list_commands() {
            let name = format!("/{}", command.name);
            assert!(
                has_cmd(&candidates, &name),
                "slash completion should list {name}"
            );
            // Agent command descriptions appear in the tip menu.
            assert!(
                candidates.iter().any(|c| {
                    c.replacement.trim_end() == name && c.display.contains(command.description)
                }),
                "tip menu for {name} should show agent description"
            );
        }
        for cmd in CLI_LOCAL_SLASH_COMMANDS {
            assert!(
                has_cmd(&candidates, cmd),
                "CLI-local command {cmd} missing from completer under `/`"
            );
        }

        // Test no match
        let (_pos, candidates) = completer.complete_slash_commands("/nonexistent").unwrap();
        assert_eq!(candidates.len(), 0);
    }

    #[test]
    fn test_completer_complete_slash_prefix() {
        use rustyline::completion::Completer;
        use rustyline::history::DefaultHistory;
        use rustyline::Context;

        let cache = create_test_cache();
        let completer = GooseCompleter::new(cache);
        let history = DefaultHistory::new();
        let ctx = Context::new(&history);

        let line = "/";
        let (pos, candidates) = Completer::complete(&completer, line, line.len(), &ctx).unwrap();
        assert_eq!(pos, 0);
        assert!(
            !candidates.is_empty(),
            "Completer::complete(\"/\") must yield slash-command candidates"
        );
        for cmd in SPLASH_SLASH_COMMANDS {
            assert!(
                has_cmd(&candidates, cmd),
                "Completer::complete path missing splash command {cmd}"
            );
        }

        // Prefix filtering via the public complete entry point
        let line = "/pl";
        let (pos, candidates) = Completer::complete(&completer, line, line.len(), &ctx).unwrap();
        assert_eq!(pos, 0);
        assert!(
            has_cmd(&candidates, "/plan"),
            "Completer::complete(\"/pl\") should include /plan"
        );

        let line = "/zzznomatch";
        let (_pos, candidates) = Completer::complete(&completer, line, line.len(), &ctx).unwrap();
        assert!(
            candidates.is_empty(),
            "unknown prefix should yield no slash-command candidates"
        );
    }

    #[test]
    fn test_tab_cycles_slash_command_order() {
        // First Tab on `/` should offer splash commands first (circular order).
        let all = matching_slash_commands("/");
        assert!(all.len() > 5);
        for cmd in SPLASH_SLASH_COMMANDS {
            assert!(
                all.iter().any(|(n, _)| n == cmd),
                "cycle list missing splash command {cmd}"
            );
        }
        // Splash order: first match for bare `/` is /help.
        assert_eq!(
            all[0].0, "/help",
            "first Tab on `/` should complete to /help"
        );

        let cache = create_test_cache();
        let completer = GooseCompleter::new(cache);
        let (pos, candidates) = completer.complete_slash_commands("/").unwrap();
        assert_eq!(pos, 0);
        assert_eq!(
            candidates[0].replacement, "/help ",
            "circular Tab writes first candidate into the line"
        );
        assert_eq!(
            candidates[1].replacement.trim_end(),
            "/status",
            "second Tab cycles to the next candidate"
        );

        // Partial prefix: /ex → /exit then /extension
        let (pos, candidates) = completer.complete_slash_commands("/ex").unwrap();
        assert_eq!(pos, 0);
        let names = candidate_names(&candidates);
        assert!(names.len() >= 2, "got {names:?}");
        assert!(names.iter().all(|n| n.starts_with("/ex")));

        let none = matching_slash_commands("/zzznomatch");
        assert!(none.is_empty());
    }

    #[test]
    fn test_session_editor_uses_circular_completion() {
        // Drive the real config builder used by CliSession::create_editor.
        let config = crate::session::session_editor_config(None);
        assert_eq!(
            config.completion_type(),
            rustyline::CompletionType::Circular,
            "Tab should cycle completions without executing"
        );
    }

    #[test]
    fn test_slash_command_completion_hint() {
        use rustyline::hint::Hinter;
        use rustyline::history::DefaultHistory;
        use rustyline::Context;

        let cache = create_test_cache();
        let completer = GooseCompleter::new(cache);
        let history = DefaultHistory::new();
        let ctx = Context::new(&history);

        let empty = completer.hint("", 0, &ctx).expect("empty-line hint");
        assert!(
            empty.contains("Tab complete") || empty.contains("/commands"),
            "default empty-line hint should mention Tab complete: {empty}"
        );

        let slash = completer.hint("/", 1, &ctx).expect("slash hint");
        assert!(
            slash.contains("Tab") && slash.contains("complete"),
            "typing / should hint Tab complete via menu: {slash}"
        );

        let partial = completer.hint("/pl", 3, &ctx).expect("partial slash hint");
        assert!(
            partial.contains("Tab") && partial.contains("/plan"),
            "partial /pl should mention menu and /plan: {partial}"
        );

        // After a space, argument completion applies — no command-name tip.
        assert!(completer.hint("/plan ", 6, &ctx).is_none());
        assert!(completer.hint("hello", 5, &ctx).is_none());
    }

    #[test]
    fn test_slash_menu_helpers() {
        assert!(is_slash_command_name_input("", 0));
        assert!(is_slash_command_name_input("/", 1));
        assert!(is_slash_command_name_input("/pl", 3));
        assert!(!is_slash_command_name_input("/plan hello", 11));
        assert!(!is_slash_command_name_input("hello", 5));

        // Unique match skips interactive select.
        assert_eq!(
            prompt_slash_command_tip_menu("/exit"),
            Some("/exit".to_string())
        );
        assert!(prompt_slash_command_tip_menu("/zzznomatch").is_none());

        // Tab cycles forward with wrap; Shift+Tab reverse with wrap.
        assert_eq!(cycle_menu_index(3, 0, true), 1);
        assert_eq!(cycle_menu_index(3, 1, true), 2);
        assert_eq!(cycle_menu_index(3, 2, true), 0);
        assert_eq!(cycle_menu_index(3, 0, false), 2);
        assert_eq!(cycle_menu_index(3, 2, false), 1);
        assert_eq!(cycle_menu_index(1, 0, true), 0);
        assert_eq!(cycle_menu_index(0, 0, true), 0);
    }

    #[test]
    fn test_complete_model_names() {
        let cache = create_test_cache();
        let completer = GooseCompleter::new(cache);

        let (pos, candidates) = completer.complete_model_names("/model ").unwrap();
        assert_eq!(pos, "/model ".len());
        assert!(candidates.is_empty());

        let (pos, candidates) = completer.complete_model_names("/model gpt").unwrap();
        assert_eq!(pos, "/model gpt".len());
        assert!(candidates.is_empty());
    }

    #[test]
    fn test_complete_resume_sessions() {
        use crate::session::ResumeCompletionEntry;

        let cache = create_test_cache();
        {
            let mut guard = cache.write().unwrap();
            guard.resume_sessions = vec![
                ResumeCompletionEntry {
                    session_id: "20260326_1".to_string(),
                    name: "older-work".to_string(),
                    message_count: 3,
                    is_current: false,
                },
                ResumeCompletionEntry {
                    session_id: "20260326_2".to_string(),
                    name: "react-migration".to_string(),
                    message_count: 12,
                    is_current: false,
                },
                ResumeCompletionEntry {
                    session_id: "20260326_3".to_string(),
                    name: "current-work".to_string(),
                    message_count: 2,
                    is_current: true,
                },
                ResumeCompletionEntry {
                    session_id: "20260326_4".to_string(),
                    name: "empty-skipped".to_string(),
                    message_count: 0,
                    is_current: false,
                },
            ];
        }
        let completer = GooseCompleter::new(cache);

        // After `/resume ` list non-empty, non-current sessions
        let (pos, candidates) = completer.complete_resume_sessions("/resume ").unwrap();
        assert_eq!(pos, "/resume ".len());
        assert_eq!(candidates.len(), 2, "should skip current and empty");
        assert!(candidates.iter().any(|c| c.display.contains("older-work")));
        assert!(candidates
            .iter()
            .any(|c| c.display.contains("react-migration")));
        assert!(!candidates
            .iter()
            .any(|c| c.display.contains("current-work")));
        assert!(!candidates
            .iter()
            .any(|c| c.display.contains("empty-skipped")));

        // Prefix by name
        let (pos, candidates) = completer.complete_resume_sessions("/resume re").unwrap();
        assert_eq!(pos, "/resume ".len());
        assert_eq!(candidates.len(), 1);
        assert!(candidates[0].display.contains("react-migration"));
        assert_eq!(candidates[0].replacement, "react-migration ");

        // Prefix by session id
        let (pos, candidates) = completer
            .complete_resume_sessions("/resume 20260326_1")
            .unwrap();
        assert_eq!(pos, "/resume ".len());
        assert_eq!(candidates.len(), 1);
        assert!(candidates[0].display.contains("older-work"));
        assert_eq!(candidates[0].replacement, "20260326_1 ");

        // Partial command name still uses slash-command completion path, not args
        let (pos, candidates) = completer.complete_resume_sessions("/resumex").unwrap();
        assert!(candidates.is_empty() || pos == "/resumex".len());
    }

    #[test]
    fn test_complete_prompt_names() {
        let cache = create_test_cache();
        let completer = GooseCompleter::new(cache);

        // Test with just "/prompt "
        let (pos, candidates) = completer.complete_prompt_names("/prompt ").unwrap();
        assert_eq!(pos, 8);
        assert_eq!(candidates.len(), 3); // All prompts

        // Test with partial prompt name
        let (pos, candidates) = completer.complete_prompt_names("/prompt test").unwrap();
        assert_eq!(pos, 8);
        assert_eq!(candidates.len(), 2); // test_prompt1 and test_prompt2

        // Test with specific prompt name
        let (pos, candidates) = completer
            .complete_prompt_names("/prompt test_prompt1")
            .unwrap();
        assert_eq!(pos, 8);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].display, "test_prompt1");

        // Test with no match
        let (pos, candidates) = completer
            .complete_prompt_names("/prompt nonexistent")
            .unwrap();
        assert_eq!(pos, 8);
        assert_eq!(candidates.len(), 0);
    }

    #[test]
    fn test_complete_prompt_flags() {
        let cache = create_test_cache();
        let completer = GooseCompleter::new(cache);

        // Test with partial flag
        let (_pos, candidates) = completer
            .complete_prompt_flags("/prompt test_prompt1 --")
            .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].display, "--info");

        // Test with exact flag
        let (_pos, candidates) = completer
            .complete_prompt_flags("/prompt test_prompt1 --info")
            .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].display, "--info");

        // Test with no match
        let (_pos, candidates) = completer
            .complete_prompt_flags("/prompt test_prompt1 --nonexistent")
            .unwrap();
        assert_eq!(candidates.len(), 0);

        // Test with no flag
        let (_pos, candidates) = completer
            .complete_prompt_flags("/prompt test_prompt1")
            .unwrap();
        assert_eq!(candidates.len(), 0);
    }

    #[test]
    fn test_complete_argument_keys() {
        let cache = create_test_cache();
        let completer = GooseCompleter::new(cache);

        // Test with just a prompt name (no space after)
        // This case doesn't return any candidates in the current implementation
        let (_pos, candidates) = completer
            .complete_argument_keys("/prompt test_prompt1")
            .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].display, "required_arg=");

        // Test with partial argument
        let (_pos, candidates) = completer
            .complete_argument_keys("/prompt test_prompt1 req")
            .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].display, "required_arg=");

        // Test with one argument already provided
        let (_pos, candidates) = completer
            .complete_argument_keys("/prompt test_prompt1 required_arg=value")
            .unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].display, "optional_arg=");

        // Test with all arguments provided
        let (_pos, candidates) = completer
            .complete_argument_keys("/prompt test_prompt1 required_arg=value optional_arg=value")
            .unwrap();
        assert_eq!(candidates.len(), 0);

        // Test with prompt that has no arguments
        let (_pos, candidates) = completer
            .complete_argument_keys("/prompt test_prompt2")
            .unwrap();
        assert_eq!(candidates.len(), 0);

        // Test with nonexistent prompt
        let (_pos, candidates) = completer
            .complete_argument_keys("/prompt nonexistent")
            .unwrap();
        assert_eq!(candidates.len(), 0);
    }
}

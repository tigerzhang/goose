use crate::subprocess::SubprocessExt;
use indoc::formatdoc;
use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, Content, ErrorCode, ErrorData, Implementation, InitializeResult,
        ServerCapabilities, ServerInfo,
    },
    schemars::JsonSchema,
    service::RequestContext,
    tool, tool_handler, tool_router, RoleServer, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env, fs,
    path::{Path, PathBuf},
};
use tokio::process::Command;

const WORKING_DIR_HEADER: &str = "agent-working-dir";

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct GrokRunParams {
    /// Prompt for Grok Build to execute
    pub prompt: String,
    /// Working directory for the Grok session. Defaults to goose's current project directory.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Existing Grok session ID to resume (`grok --resume`)
    #[serde(default)]
    pub session_id: Option<String>,
    /// Continue the most recent Grok session in the working directory (`grok --continue`)
    #[serde(default)]
    pub continue_last: bool,
    /// Grok model ID (for example grok-4.6). Omit to use Grok's default.
    #[serde(default)]
    pub model: Option<String>,
    /// Maximum Grok agent turns before stopping
    #[serde(default)]
    pub max_turns: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct GrokSessionsParams {
    /// Optional search query over session titles and prompts
    #[serde(default)]
    pub query: Option<String>,
    /// Maximum number of sessions to list (default 20)
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct GrokStatusParams {
    /// Grok session ID from grok_run or grok_sessions
    pub session_id: String,
}

#[derive(Clone)]
pub struct GrokServer {
    tool_router: ToolRouter<Self>,
    instructions: String,
}

impl Default for GrokServer {
    fn default() -> Self {
        Self::new()
    }
}

#[tool_router(router = tool_router)]
impl GrokServer {
    pub fn new() -> Self {
        let instructions = formatdoc! {r#"
            The Grok Build CLI extension is enabled. Use it to delegate work to the local `grok` CLI
            (Grok Build) without changing goose's LLM provider.

            Workflow:
            1. Call grok_run with a clear prompt. It starts a Grok session, lets Grok use its own
               tools, and returns the result plus a session_id.
            2. To continue the same Grok conversation, call grok_run again with that session_id.
            3. Call grok_sessions to list recent Grok sessions, or grok_status to inspect one.

            grok_run always uses Grok headless mode (`grok -p`) with --always-approve so it can
            finish without a TTY. The Grok session is stored under ~/.grok/sessions/.

            Requires the `grok` binary on PATH (or GROK_COMMAND / ~/.local/bin/grok / ~/.grok/bin/grok)
            and an authenticated Grok Build install (`grok login` or XAI_API_KEY).
            "#};

        Self {
            tool_router: Self::tool_router(),
            instructions,
        }
    }

    /// Run a prompt through the Grok Build CLI (`grok -p`) and return the result plus session id.
    #[tool(
        name = "grok_run",
        description = "Send a prompt to the local Grok Build CLI (grok -p). Returns Grok's result and session_id so you can resume or check status later."
    )]
    pub async fn grok_run(
        &self,
        params: Parameters<GrokRunParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, ErrorData> {
        let params = params.0;
        if params.prompt.trim().is_empty() {
            return Err(ErrorData::new(
                ErrorCode::INVALID_PARAMS,
                "prompt must not be empty",
                None,
            ));
        }

        let cwd = resolve_cwd(params.cwd.as_deref(), &context);
        let args = build_run_args(&params);
        let output = run_grok(&args, Some(&cwd)).await?;
        Ok(CallToolResult::success(vec![Content::text(
            format_run_output(&output),
        )]))
    }

    /// List or search Grok Build sessions for the current working directory.
    #[tool(
        name = "grok_sessions",
        description = "List recent Grok Build sessions, or search them by keyword. Use this to find a session_id for grok_run or grok_status."
    )]
    pub async fn grok_sessions(
        &self,
        params: Parameters<GrokSessionsParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let params = params.0;
        let mut args = vec!["sessions".to_string()];
        if let Some(query) = params
            .query
            .as_deref()
            .map(str::trim)
            .filter(|q| !q.is_empty())
        {
            args.push("search".to_string());
            args.push(query.to_string());
        } else {
            args.push("list".to_string());
        }
        if let Some(limit) = params.limit {
            args.push("--limit".to_string());
            args.push(limit.to_string());
        }

        let output = run_grok(&args, None).await?;
        Ok(CallToolResult::success(vec![Content::text(output)]))
    }

    /// Read status for a Grok Build session (title, model, timestamps, token usage).
    #[tool(
        name = "grok_status",
        description = "Inspect a Grok Build session by id: summary, model, timestamps, message counts, and usage signals."
    )]
    pub async fn grok_status(
        &self,
        params: Parameters<GrokStatusParams>,
    ) -> Result<CallToolResult, ErrorData> {
        let session_id = params.0.session_id.trim();
        if session_id.is_empty() {
            return Err(ErrorData::new(
                ErrorCode::INVALID_PARAMS,
                "session_id must not be empty",
                None,
            ));
        }

        let Some(dir) = find_session_dir(&grok_home().join("sessions"), session_id) else {
            return Err(ErrorData::new(
                ErrorCode::INVALID_PARAMS,
                format!("No Grok session found for id {session_id}"),
                None,
            ));
        };

        Ok(CallToolResult::success(vec![Content::text(
            format_session_status(&dir, session_id),
        )]))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for GrokServer {
    fn get_info(&self) -> ServerInfo {
        InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("goose-grok", env!("CARGO_PKG_VERSION")))
            .with_instructions(self.instructions.clone())
    }
}

fn extract_working_dir_from_meta(meta: &rmcp::model::Meta) -> Option<PathBuf> {
    meta.0
        .get(WORKING_DIR_HEADER)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn resolve_cwd(explicit: Option<&str>, context: &RequestContext<RoleServer>) -> PathBuf {
    if let Some(cwd) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        return PathBuf::from(cwd);
    }
    extract_working_dir_from_meta(&context.meta)
        .or_else(|| env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn user_home() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn grok_home() -> PathBuf {
    env::var("GROK_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| user_home().map(|home| home.join(".grok")))
        .unwrap_or_else(|| PathBuf::from(".grok"))
}

fn resolve_grok_command() -> Result<PathBuf, ErrorData> {
    if let Ok(explicit) = env::var("GROK_COMMAND") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Ok(path);
        }
        return Err(ErrorData::new(
            ErrorCode::INTERNAL_ERROR,
            format!("GROK_COMMAND is set but not a file: {}", path.display()),
            None,
        ));
    }

    if let Ok(path) = which::which("grok") {
        return Ok(path);
    }

    let fallbacks = [
        user_home().map(|h| h.join(".local/bin/grok")),
        user_home().map(|h| h.join(".grok/bin/grok")),
    ];
    for candidate in fallbacks.into_iter().flatten() {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }

    Err(ErrorData::new(
        ErrorCode::INTERNAL_ERROR,
        "Could not find the Grok Build CLI. Install it with `curl -fsSL https://x.ai/cli/install.sh | bash`, then run `grok login`. Set GROK_COMMAND if grok is not on PATH.",
        None,
    ))
}

fn build_run_args(params: &GrokRunParams) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        params.prompt.clone(),
        "--output-format".to_string(),
        "json".to_string(),
        "--always-approve".to_string(),
    ];
    if let Some(session_id) = params
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.push("--resume".to_string());
        args.push(session_id.to_string());
    } else if params.continue_last {
        args.push("--continue".to_string());
    }
    if let Some(model) = params
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        args.push("-m".to_string());
        args.push(model.to_string());
    }
    if let Some(max_turns) = params.max_turns {
        args.push("--max-turns".to_string());
        args.push(max_turns.to_string());
    }
    args
}

async fn run_grok(args: &[String], cwd: Option<&Path>) -> Result<String, ErrorData> {
    let command = resolve_grok_command()?;
    let mut cmd = Command::new(&command);
    cmd.args(args).set_no_window();
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }

    let output = cmd.output().await.map_err(|e| {
        ErrorData::new(
            ErrorCode::INTERNAL_ERROR,
            format!("Failed to start {}: {e}", command.display()),
            None,
        )
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(ErrorData::new(
            ErrorCode::INTERNAL_ERROR,
            format!(
                "grok exited with {}: {detail}",
                output.status.code().unwrap_or(-1)
            ),
            None,
        ));
    }
    Ok(stdout)
}

fn format_run_output(stdout: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(stdout) else {
        return stdout.to_string();
    };
    let text = value.get("text").and_then(Value::as_str).unwrap_or(stdout);
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("(unknown)");
    let stop = value
        .get("stopReason")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    format!("session_id: {session_id}\nstop_reason: {stop}\n\n{text}")
}

fn find_session_dir(sessions_root: &Path, session_id: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(sessions_root).ok()?;
    for entry in entries.flatten() {
        let group = entry.path();
        if !group.is_dir() {
            continue;
        }
        let candidate = group.join(session_id);
        if candidate.join("summary.json").is_file() {
            return Some(candidate);
        }
    }
    None
}

fn format_session_status(dir: &Path, session_id: &str) -> String {
    let summary = read_json(dir.join("summary.json"));
    let signals = read_json(dir.join("signals.json"));
    let info = summary.get("info").cloned().unwrap_or(Value::Null);

    let field = |obj: &Value, key: &str| {
        obj.get(key)
            .map(|v| match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            })
            .unwrap_or_else(|| "-".to_string())
    };

    format!(
        "session_id: {session_id}\n\
         cwd: {}\n\
         title: {}\n\
         summary: {}\n\
         model: {}\n\
         agent: {}\n\
         created_at: {}\n\
         updated_at: {}\n\
         last_active_at: {}\n\
         messages: {}\n\
         chat_messages: {}\n\
         last_turn_summary: {}\n\
         turns: {}\n\
         tool_calls: {}\n\
         context_tokens_used: {}\n\
         context_window: {}\n\
         errors: {}\n\
         path: {}",
        field(&info, "cwd"),
        field(&summary, "generated_title"),
        field(&summary, "session_summary"),
        field(&summary, "current_model_id"),
        field(&summary, "agent_name"),
        field(&summary, "created_at"),
        field(&summary, "updated_at"),
        field(&summary, "last_active_at"),
        field(&summary, "num_messages"),
        field(&summary, "num_chat_messages"),
        field(&summary, "last_turn_summary"),
        field(&signals, "turnCount"),
        field(&signals, "toolCallCount"),
        field(&signals, "contextTokensUsed"),
        field(&signals, "contextWindowTokens"),
        field(&signals, "errorCount"),
        dir.display()
    )
}

fn read_json(path: PathBuf) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| serde_json::from_str(&contents).ok())
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_params(prompt: &str) -> GrokRunParams {
        GrokRunParams {
            prompt: prompt.to_string(),
            cwd: None,
            session_id: None,
            continue_last: false,
            model: None,
            max_turns: None,
        }
    }

    #[test]
    fn run_args_include_headless_json_and_always_approve() {
        assert_eq!(
            build_run_args(&run_params("review this crate")),
            vec![
                "-p",
                "review this crate",
                "--output-format",
                "json",
                "--always-approve"
            ]
        );
    }

    #[test]
    fn run_args_resume_and_model_and_max_turns() {
        let mut params = run_params("continue");
        params.session_id = Some("abc-123".to_string());
        params.continue_last = true;
        params.model = Some("grok-4.6".to_string());
        params.max_turns = Some(8);
        assert_eq!(
            build_run_args(&params),
            vec![
                "-p",
                "continue",
                "--output-format",
                "json",
                "--always-approve",
                "--resume",
                "abc-123",
                "-m",
                "grok-4.6",
                "--max-turns",
                "8"
            ]
        );
    }

    #[test]
    fn format_run_output_extracts_session_and_text() {
        let formatted =
            format_run_output(r#"{"text":"done","stopReason":"end_turn","sessionId":"sess-1"}"#);
        assert!(formatted.contains("session_id: sess-1"));
        assert!(formatted.contains("stop_reason: end_turn"));
        assert!(formatted.contains("done"));
    }

    #[test]
    fn find_session_dir_walks_encoded_cwd_groups() {
        let root = tempfile::tempdir().unwrap();
        let sessions = root.path().join("sessions");
        let session = sessions.join("%2Ftmp").join("sess-xyz");
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("summary.json"), "{}").unwrap();

        assert_eq!(
            find_session_dir(&sessions, "sess-xyz").as_deref(),
            Some(session.as_path())
        );
        assert!(find_session_dir(&sessions, "missing").is_none());
    }

    #[test]
    fn grok_server_advertises_tools() {
        let server = GrokServer::new();
        let info = server.get_info();
        assert_eq!(info.server_info.name, "goose-grok");
        assert!(info
            .instructions
            .unwrap()
            .contains("Grok Build CLI extension"));
    }
}

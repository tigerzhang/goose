use anyhow::{anyhow, Result};

use crate::conversation::Conversation;
use crate::session::session_manager::{Session, SessionManager, SessionType};

/// A session resolved for `/resume` or equivalent CLI resume selection.
#[derive(Debug, Clone)]
pub struct ResumedSession {
    pub session_id: String,
    pub name: String,
    pub conversation: Conversation,
}

/// One row in the `/resume` session list (bare `/resume` with no target).
#[derive(Debug, Clone)]
pub struct ResumeSessionListEntry {
    pub session_id: String,
    pub name: String,
    pub message_count: usize,
    pub is_current: bool,
}

/// List user sessions available to resume (most recent first).
///
/// Only includes sessions with at least one message. Empty sessions are omitted
/// so the `/resume` tip menu stays useful.
pub async fn list_resume_sessions(
    manager: &SessionManager,
    current_session_id: Option<&str>,
) -> Result<Vec<ResumeSessionListEntry>> {
    let sessions = manager.list_sessions_by_types(&[SessionType::User]).await?;
    Ok(sessions
        .into_iter()
        .filter(|s| s.message_count > 0)
        .map(|s| session_to_list_entry(s, current_session_id))
        .collect())
}

/// Sessions that can be selected from the tip menu (non-empty, not the current one).
pub fn selectable_resume_sessions(
    entries: &[ResumeSessionListEntry],
) -> Vec<&ResumeSessionListEntry> {
    entries.iter().filter(|e| !e.is_current).collect()
}

fn session_to_list_entry(
    session: Session,
    current_session_id: Option<&str>,
) -> ResumeSessionListEntry {
    ResumeSessionListEntry {
        session_id: session.id.clone(),
        name: session.name,
        message_count: session.message_count,
        is_current: current_session_id.is_some_and(|id| id == session.id),
    }
}

/// Display label for a resume-list entry (used by tip menu and text list).
pub fn format_resume_session_label(entry: &ResumeSessionListEntry) -> String {
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
    let current = if entry.is_current { " · current" } else { "" };
    format!(
        "{name}  ({msgs})  [{id}]{current}",
        name = name,
        msgs = msgs,
        id = entry.session_id,
        current = current
    )
}

/// Format a human-readable list of saved sessions for non-interactive `/resume`.
pub fn format_resume_session_list(
    entries: &[ResumeSessionListEntry],
    _current_session_id: Option<&str>,
) -> String {
    let selectable = selectable_resume_sessions(entries);
    if selectable.is_empty() {
        return "No other saved sessions with messages found.\n\nChat in a session first, then use `/resume` to pick one."
            .to_string();
    }

    let mut lines = Vec::new();
    lines.push("Saved sessions with messages (most recent first):".to_string());
    lines.push(String::new());

    for entry in selectable {
        lines.push(format!("  {}", format_resume_session_label(entry)));
    }

    lines.push(String::new());
    lines.push("In the interactive CLI, `/resume` opens a tip menu to pick one.".to_string());
    lines.push("Or resume directly: `/resume <name-or-id>`".to_string());
    lines.join("\n")
}

/// Resolve which session to resume from storage.
///
/// `target` is required (name or id). Bare `/resume` should list sessions via
/// [`list_resume_sessions`] / [`format_resume_session_list`] instead.
///
/// Loads full conversation history for the resolved session.
pub async fn resolve_resume_session(
    manager: &SessionManager,
    target: &str,
    _exclude_session_id: Option<&str>,
) -> Result<ResumedSession> {
    let target = target.trim();
    if target.is_empty() {
        return Err(anyhow!(
            "Specify a session name or id. Use `/resume` to list saved sessions."
        ));
    }

    let session_id = if manager.get_session(target, false).await.is_ok() {
        target.to_string()
    } else {
        let sessions = manager.list_sessions().await?;
        sessions
            .into_iter()
            .find(|s| s.name == target || s.id == target)
            .map(|s| s.id)
            .ok_or_else(|| anyhow!("No session found with name or id '{}'", target))?
    };

    let session = manager
        .get_session(&session_id, true)
        .await
        .map_err(|_| anyhow!("No session found to resume"))?;

    Ok(ResumedSession {
        session_id: session.id,
        name: session.name,
        conversation: session.conversation.unwrap_or_default(),
    })
}

/// Parse `/resume` arguments: bare command, or a single name/id token.
pub fn parse_resume_target(params_str: &str) -> Option<&str> {
    let trimmed = params_str.trim();
    if trimmed.is_empty() {
        None
    } else {
        // First whitespace-separated token is the target; extra args are ignored.
        Some(trimmed.split_whitespace().next().unwrap_or(trimmed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::GooseMode;
    use crate::conversation::message::Message;
    use std::path::PathBuf;
    use tempfile::TempDir;

    async fn create_user_session(sm: &SessionManager, name: &str, messages: &[&str]) -> String {
        let session = sm
            .create_session(
                PathBuf::from("/tmp/resume-test"),
                name.to_string(),
                SessionType::User,
                GooseMode::default(),
            )
            .await
            .unwrap();
        for text in messages {
            sm.add_message(&session.id, &Message::user().with_text(*text))
                .await
                .unwrap();
        }
        session.id
    }

    #[tokio::test]
    async fn list_resume_sessions_skips_empty_marks_current_and_formats_labels() {
        let temp = TempDir::new().unwrap();
        let sm = SessionManager::new(temp.path().to_path_buf());

        // Empty session should not appear in the tip list.
        let _empty = sm
            .create_session(
                PathBuf::from("/tmp/resume-test"),
                "empty-session".to_string(),
                SessionType::User,
                GooseMode::default(),
            )
            .await
            .unwrap();

        let older = create_user_session(&sm, "older-work", &["hello from older"]).await;
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let current = create_user_session(&sm, "current-work", &["a", "b"]).await;

        let entries = list_resume_sessions(&sm, Some(&current)).await.unwrap();
        assert!(
            entries.iter().all(|e| e.message_count > 0),
            "empty sessions must be filtered out"
        );
        assert!(entries.iter().any(|e| e.session_id == older));
        assert!(entries
            .iter()
            .any(|e| e.session_id == current && e.is_current));
        assert!(!entries.iter().any(|e| e.name == "empty-session"));

        let selectable = selectable_resume_sessions(&entries);
        assert!(selectable.iter().all(|e| !e.is_current));
        assert!(selectable.iter().any(|e| e.session_id == older));

        let list = format_resume_session_list(&entries, Some(&current));
        assert!(list.contains("Saved sessions") || list.contains("with messages"));
        assert!(list.contains(&older));
        assert!(list.contains("older-work"));
        // Current is not in the selectable text list
        assert!(!list.contains(&current) || list.contains("tip menu"));
        assert!(list.contains("/resume <name-or-id>"));

        let label =
            format_resume_session_label(entries.iter().find(|e| e.session_id == older).unwrap());
        assert!(label.contains("older-work"));
        assert!(label.contains(&older));
    }

    #[tokio::test]
    async fn resume_by_name_loads_that_session() {
        let temp = TempDir::new().unwrap();
        let sm = SessionManager::new(temp.path().to_path_buf());

        let _a = create_user_session(&sm, "alpha", &["msg-a"]).await;
        let b = create_user_session(&sm, "beta-project", &["msg-b"]).await;
        let current = create_user_session(&sm, "current", &["msg-c"]).await;

        let resumed = resolve_resume_session(&sm, "beta-project", Some(&current))
            .await
            .unwrap();

        assert_eq!(resumed.session_id, b);
        assert_eq!(resumed.name, "beta-project");
        assert!(resumed
            .conversation
            .messages()
            .iter()
            .any(|m| m.as_concat_text().contains("msg-b")));
    }

    #[tokio::test]
    async fn resume_by_id_loads_that_session() {
        let temp = TempDir::new().unwrap();
        let sm = SessionManager::new(temp.path().to_path_buf());

        let target = create_user_session(&sm, "named", &["by-id-history"]).await;
        let current = create_user_session(&sm, "current", &["now"]).await;

        let resumed = resolve_resume_session(&sm, &target, Some(&current))
            .await
            .unwrap();

        assert_eq!(resumed.session_id, target);
        assert!(resumed
            .conversation
            .messages()
            .iter()
            .any(|m| m.as_concat_text().contains("by-id-history")));
    }

    #[tokio::test]
    async fn resume_missing_target_errors_without_side_effects() {
        let temp = TempDir::new().unwrap();
        let sm = SessionManager::new(temp.path().to_path_buf());

        let current = create_user_session(&sm, "only-session", &["keep me"]).await;
        let before = sm.get_session(&current, true).await.unwrap();
        let before_count = before.message_count;

        let err = resolve_resume_session(&sm, "does-not-exist", Some(&current))
            .await
            .expect_err("missing target must fail");
        assert!(
            err.to_string().contains("does-not-exist")
                || err.to_string().to_lowercase().contains("no session"),
            "error should mention missing target: {err}"
        );

        let after = sm.get_session(&current, true).await.unwrap();
        assert_eq!(after.message_count, before_count);
        assert_eq!(after.id, current);
    }

    #[test]
    fn parse_resume_target_bare_and_named() {
        assert_eq!(parse_resume_target(""), None);
        assert_eq!(parse_resume_target("   "), None);
        assert_eq!(parse_resume_target("my-session"), Some("my-session"));
        assert_eq!(parse_resume_target("  20251108_3  "), Some("20251108_3"));
        assert_eq!(parse_resume_target("name extra"), Some("name"));
    }

    #[test]
    fn format_empty_list_is_helpful() {
        let text = format_resume_session_list(&[], None);
        assert!(
            text.to_lowercase().contains("no other saved sessions")
                || text.to_lowercase().contains("no saved sessions")
        );
    }
}

use std::collections::HashSet;
use std::env;
use std::ffi::OsString;
use std::sync::{Mutex, OnceLock};

const OPENDUCK_PREFIX: &str = "OPENDUCK_";
const GOOSE_PREFIX: &str = "GOOSE_";

static WARNED_LEGACY_KEYS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn product_suffix(key: &str) -> Option<&str> {
    for prefix in [OPENDUCK_PREFIX, GOOSE_PREFIX] {
        if let Some(rest) = key.strip_prefix(prefix) {
            if !rest.is_empty() {
                return Some(rest);
            }
        }
    }
    None
}

fn lookup_suffix(key: &str) -> String {
    let upper = key.to_ascii_uppercase();
    product_suffix(&upper).unwrap_or(&upper).to_string()
}

fn warn_legacy_once(legacy_key: &str, replacement: &str) {
    let warned = WARNED_LEGACY_KEYS.get_or_init(|| Mutex::new(HashSet::new()));
    let mut set = warned.lock().unwrap_or_else(|e| e.into_inner());
    if set.insert(legacy_key.to_string()) {
        tracing::warn!("{legacy_key} is deprecated; use {replacement} instead");
    }
}

/// Look up `OPENDUCK_<key>`, then fall back to `GOOSE_<key>` with a one-time warning.
///
/// `key` is the suffix without a product prefix, e.g. `"PROVIDER"` or `"SERVER__SECRET_KEY"`.
/// Keys that already include `OPENDUCK_` / `GOOSE_` are stripped before lookup.
pub fn get_var(key: &str) -> Option<String> {
    get_var_os(key).and_then(|value| value.into_string().ok())
}

/// OS-string variant of [`get_var`], for values such as `PATH_ROOT`.
pub fn get_var_os(key: &str) -> Option<OsString> {
    let suffix = lookup_suffix(key);
    let openduck_key = format!("{OPENDUCK_PREFIX}{suffix}");
    if let Some(value) = env::var_os(&openduck_key) {
        return Some(value);
    }

    let goose_key = format!("{GOOSE_PREFIX}{suffix}");
    if let Some(value) = env::var_os(&goose_key) {
        warn_legacy_once(&goose_key, &openduck_key);
        return Some(value);
    }

    None
}

/// Dual-lookup with Unicode error distinction, matching [`env::var`].
pub fn get_var_result(key: &str) -> Result<String, env::VarError> {
    match get_var_os(key) {
        Some(value) => value.into_string().map_err(env::VarError::NotUnicode),
        None => Err(env::VarError::NotPresent),
    }
}

/// Environment lookup for config keys.
///
/// - `GOOSE_FOO` / `OPENDUCK_FOO` dual-lookup `FOO`
/// - unprefixed keys try `OPENDUCK_{KEY}`, then `GOOSE_{KEY}`, then `{KEY}`
pub fn env_lookup(key: &str) -> Option<String> {
    let upper = key.to_ascii_uppercase();
    if product_suffix(&upper).is_some() {
        return get_var(&upper);
    }
    get_var(&upper).or_else(|| env::var(&upper).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_var_openduck_wins_over_goose() {
        let _guard = env_lock::lock_env([
            ("OPENDUCK_PROVIDER", Some("openduck-provider")),
            ("GOOSE_PROVIDER", Some("goose-provider")),
        ]);
        assert_eq!(get_var("PROVIDER").as_deref(), Some("openduck-provider"));
        assert_eq!(
            get_var("GOOSE_PROVIDER").as_deref(),
            Some("openduck-provider")
        );
    }

    #[test]
    fn get_var_falls_back_to_goose() {
        let _guard = env_lock::lock_env([
            ("OPENDUCK_PROVIDER", None::<&str>),
            ("GOOSE_PROVIDER", Some("goose-provider")),
        ]);
        assert_eq!(get_var("PROVIDER").as_deref(), Some("goose-provider"));
    }

    #[test]
    fn get_var_missing_both_returns_none() {
        let _guard = env_lock::lock_env([
            ("OPENDUCK_PROVIDER", None::<&str>),
            ("GOOSE_PROVIDER", None::<&str>),
        ]);
        assert_eq!(get_var("PROVIDER"), None);
        assert!(matches!(
            get_var_result("PROVIDER"),
            Err(env::VarError::NotPresent)
        ));
    }

    #[test]
    fn get_var_supports_nested_secret_key() {
        let _guard = env_lock::lock_env([
            ("OPENDUCK_SERVER__SECRET_KEY", Some("openduck-secret")),
            ("GOOSE_SERVER__SECRET_KEY", Some("goose-secret")),
        ]);
        assert_eq!(
            get_var("SERVER__SECRET_KEY").as_deref(),
            Some("openduck-secret")
        );
    }

    #[test]
    fn env_lookup_unprefixed_reads_raw_key() {
        let _guard = env_lock::lock_env([
            ("OPENDUCK_OPENAI_API_KEY", None::<&str>),
            ("GOOSE_OPENAI_API_KEY", None::<&str>),
            ("OPENAI_API_KEY", Some("sk-raw")),
        ]);
        assert_eq!(env_lookup("openai_api_key").as_deref(), Some("sk-raw"));
    }

    #[test]
    fn env_lookup_goose_prefixed_key_prefers_openduck() {
        let _guard = env_lock::lock_env([
            ("OPENDUCK_MODE", Some("auto")),
            ("GOOSE_MODE", Some("approve")),
        ]);
        assert_eq!(env_lookup("GOOSE_MODE").as_deref(), Some("auto"));
        assert_eq!(env_lookup("MODE").as_deref(), Some("auto"));
    }
}

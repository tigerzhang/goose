use etcetera::{choose_app_strategy, AppStrategy, AppStrategyArgs};
use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::config::env as openduck_env;

pub const PROJECT_DIR_NAMES: [&str; 2] = [".openduck", ".goose"];

fn current_app_args() -> AppStrategyArgs {
    AppStrategyArgs {
        top_level_domain: "dev".to_string(),
        author: "OpenDuck".to_string(),
        app_name: "OpenDuck".to_string(),
    }
}

fn legacy_app_args() -> AppStrategyArgs {
    AppStrategyArgs {
        top_level_domain: "Block".to_string(),
        author: "Block".to_string(),
        app_name: "goose".to_string(),
    }
}

fn strategy_dir(args: AppStrategyArgs, dir_type: DirType) -> PathBuf {
    let strategy = choose_app_strategy(args).expect("openduck requires a home dir");
    match dir_type {
        DirType::Config => strategy.config_dir(),
        DirType::Data => strategy.data_dir(),
        DirType::State => strategy.state_dir().unwrap_or(strategy.data_dir()),
        DirType::Plugins => strategy.home_dir().join(".agents").join("plugins"),
        DirType::Agents => strategy.home_dir().join(".agents").join("agents"),
        DirType::AgentsHome => strategy.home_dir().join(".agents"),
    }
}

fn dir_is_populated(path: &Path) -> bool {
    if path.is_file() {
        return true;
    }
    std::fs::read_dir(path)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

fn copy_dir_all(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir_all(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

static MIGRATION_ATTEMPTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn maybe_migrate_dir(new_dir: &Path, legacy_dir: &Path) {
    if new_dir == legacy_dir || dir_is_populated(new_dir) || !legacy_dir.exists() {
        return;
    }

    let attempted = MIGRATION_ATTEMPTS.get_or_init(|| Mutex::new(HashSet::new()));
    {
        let mut set = attempted.lock().unwrap_or_else(|e| e.into_inner());
        if !set.insert(new_dir.to_path_buf()) {
            return;
        }
    }

    match copy_dir_all(legacy_dir, new_dir) {
        Ok(()) => {
            let message = format!(
                "Migrated configuration from {} to {}. The original files were left in place.",
                legacy_dir.display(),
                new_dir.display()
            );
            eprintln!("{message}");
            tracing::info!("{message}");
        }
        Err(error) => {
            tracing::warn!(
                "Failed to migrate {} to {}: {error}",
                legacy_dir.display(),
                new_dir.display()
            );
        }
    }
}

pub struct Paths;

impl Paths {
    fn get_dir(dir_type: DirType) -> PathBuf {
        if let Some(base) = Self::path_root() {
            return match dir_type {
                DirType::Config => base.join("config"),
                DirType::Data => base.join("data"),
                DirType::State => base.join("state"),
                DirType::Plugins => base.join(".agents").join("plugins"),
                DirType::Agents => base.join(".agents").join("agents"),
                DirType::AgentsHome => base.join(".agents"),
            };
        }

        let new_dir = strategy_dir(current_app_args(), dir_type);
        match dir_type {
            DirType::Config | DirType::Data | DirType::State => {
                let legacy_dir = strategy_dir(legacy_app_args(), dir_type);
                maybe_migrate_dir(&new_dir, &legacy_dir);
                if dir_is_populated(&new_dir) {
                    new_dir
                } else if dir_is_populated(&legacy_dir) {
                    legacy_dir
                } else {
                    new_dir
                }
            }
            DirType::Plugins | DirType::Agents | DirType::AgentsHome => new_dir,
        }
    }

    pub(crate) fn path_root() -> Option<PathBuf> {
        Self::validated_path_root(openduck_env::get_var_os("PATH_ROOT"))
    }

    fn validated_path_root(value: Option<OsString>) -> Option<PathBuf> {
        value.map(PathBuf::from).filter(|path| path.is_absolute())
    }

    /// Legacy goose directories using the Block/goose etcetera strategy.
    pub fn legacy_config_dir() -> PathBuf {
        strategy_dir(legacy_app_args(), DirType::Config)
    }

    pub fn config_dir() -> PathBuf {
        Self::get_dir(DirType::Config)
    }

    pub fn data_dir() -> PathBuf {
        Self::get_dir(DirType::Data)
    }

    pub fn state_dir() -> PathBuf {
        Self::get_dir(DirType::State)
    }

    pub fn plugins_dir() -> PathBuf {
        Self::get_dir(DirType::Plugins)
    }

    pub fn agents_dir() -> PathBuf {
        Self::get_dir(DirType::Agents)
    }

    pub fn agents_home_dir() -> PathBuf {
        Self::get_dir(DirType::AgentsHome)
    }

    pub fn in_agents_home_dir(subpath: &str) -> PathBuf {
        Self::agents_home_dir().join(subpath)
    }

    pub fn in_state_dir(subpath: &str) -> PathBuf {
        Self::state_dir().join(subpath)
    }

    pub fn in_config_dir(subpath: &str) -> PathBuf {
        Self::config_dir().join(subpath)
    }

    pub fn in_data_dir(subpath: &str) -> PathBuf {
        Self::data_dir().join(subpath)
    }

    pub fn project_dir_names() -> &'static [&'static str] {
        &PROJECT_DIR_NAMES
    }

    /// Prefer an existing `.openduck/` directory, then `.goose/`, else `.openduck/`.
    pub fn find_project_dir(cwd: &Path) -> PathBuf {
        for name in PROJECT_DIR_NAMES {
            let candidate = cwd.join(name);
            if candidate.is_dir() {
                return candidate;
            }
        }
        cwd.join(PROJECT_DIR_NAMES[0])
    }
}

#[derive(Clone, Copy)]
enum DirType {
    Config,
    Data,
    State,
    Plugins,
    Agents,
    AgentsHome,
}

#[cfg(test)]
mod tests {
    use super::Paths;
    use std::ffi::OsString;
    use std::fs;

    #[test]
    fn path_root_requires_an_absolute_path() {
        assert_eq!(Paths::validated_path_root(None), None);
        assert_eq!(Paths::validated_path_root(Some(OsString::new())), None);
        assert_eq!(
            Paths::validated_path_root(Some(OsString::from("relative/root"))),
            None
        );

        let absolute = std::env::current_dir()
            .unwrap()
            .join("nonexistent-goose-root");
        assert_eq!(
            Paths::validated_path_root(Some(absolute.clone().into_os_string())),
            Some(absolute)
        );
    }

    #[test]
    fn path_root_openduck_wins_over_goose() {
        let openduck = std::env::current_dir()
            .unwrap()
            .join("nonexistent-openduck-root");
        let goose = std::env::current_dir()
            .unwrap()
            .join("nonexistent-goose-root");
        let openduck_s = openduck.to_string_lossy().into_owned();
        let goose_s = goose.to_string_lossy().into_owned();
        let _guard = env_lock::lock_env([
            ("OPENDUCK_PATH_ROOT", Some(openduck_s.as_str())),
            ("GOOSE_PATH_ROOT", Some(goose_s.as_str())),
        ]);
        assert_eq!(Paths::path_root(), Some(openduck));
    }

    #[test]
    fn path_root_falls_back_to_goose() {
        let goose = std::env::current_dir()
            .unwrap()
            .join("nonexistent-goose-root");
        let goose_s = goose.to_string_lossy().into_owned();
        let _guard = env_lock::lock_env([
            ("OPENDUCK_PATH_ROOT", None::<&str>),
            ("GOOSE_PATH_ROOT", Some(goose_s.as_str())),
        ]);
        assert_eq!(Paths::path_root(), Some(goose));
    }

    #[test]
    fn path_root_rejects_relative_openduck_and_goose() {
        let _guard = env_lock::lock_env([
            ("OPENDUCK_PATH_ROOT", Some("relative/openduck")),
            ("GOOSE_PATH_ROOT", Some("relative/goose")),
        ]);
        assert_eq!(Paths::path_root(), None);
    }

    #[cfg(unix)]
    #[test]
    fn config_dir_migrates_legacy_goose_config() {
        let tmp = tempfile::TempDir::new().unwrap();
        let xdg_config = tmp.path().join("xdg-config");
        let xdg_data = tmp.path().join("xdg-data");
        let xdg_state = tmp.path().join("xdg-state");
        let xdg_config_s = xdg_config.to_string_lossy().into_owned();
        let xdg_data_s = xdg_data.to_string_lossy().into_owned();
        let xdg_state_s = xdg_state.to_string_lossy().into_owned();

        let _guard = env_lock::lock_env([
            ("OPENDUCK_PATH_ROOT", None::<&str>),
            ("GOOSE_PATH_ROOT", None::<&str>),
            ("XDG_CONFIG_HOME", Some(xdg_config_s.as_str())),
            ("XDG_DATA_HOME", Some(xdg_data_s.as_str())),
            ("XDG_STATE_HOME", Some(xdg_state_s.as_str())),
        ]);

        let legacy = Paths::legacy_config_dir();
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("config.yaml"), "GOOSE_PROVIDER: openai\n").unwrap();

        let new_dir = Paths::config_dir();
        assert_eq!(new_dir, xdg_config.join("openduck"));
        assert_eq!(
            fs::read_to_string(new_dir.join("config.yaml")).unwrap(),
            "GOOSE_PROVIDER: openai\n"
        );
        assert!(legacy.join("config.yaml").exists());
    }

    #[test]
    fn find_project_dir_prefers_openduck() {
        let tmp = tempfile::TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".openduck")).unwrap();
        fs::create_dir_all(tmp.path().join(".goose")).unwrap();
        assert_eq!(
            Paths::find_project_dir(tmp.path()),
            tmp.path().join(".openduck")
        );
    }

    #[test]
    fn find_project_dir_falls_back_to_goose() {
        let tmp = tempfile::TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".goose")).unwrap();
        assert_eq!(
            Paths::find_project_dir(tmp.path()),
            tmp.path().join(".goose")
        );
    }
}

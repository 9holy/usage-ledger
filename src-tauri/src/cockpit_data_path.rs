//! Read-only selection of Cockpit Tools' data directory.
//!
//! Contract: jlcodes99/cockpit-tools@820e176842d440a60e650729c3a39932b76a0ccb,
//! crates/cockpit-core/src/modules/data_paths.rs::select_root/resolve_data_dir.
//! Never create, merge, rename or link upstream directories while discovering
//! data. An explicit missing directory must not fall back to another account pool.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

fn configured_directory() -> Result<Option<PathBuf>, String> {
    let value = match std::env::var("COCKPIT_TOOLS_DATA_DIR") {
        Ok(value) => value,
        Err(std::env::VarError::NotPresent) => return Ok(None),
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err("COCKPIT_TOOLS_DATA_DIR 不是有效的 Unicode 路径".to_string());
        }
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    let path = PathBuf::from(value);
    // Upstream resolves a relative override from its own process directory.
    // This independent reader cannot prove it has that same working directory.
    if !path.is_absolute() {
        return Err("COCKPIT_TOOLS_DATA_DIR 必须使用绝对路径；无法确认 Cockpit 进程的相对路径基准".to_string());
    }
    Ok(Some(path))
}

pub fn data_dir() -> Result<PathBuf, String> {
    if let Some(path) = configured_directory()? {
        return Ok(path);
    }
    let home = std::env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("HOME").filter(|value| !value.is_empty()))
        .ok_or_else(|| "无法定位用户主目录(USERPROFILE/HOME 均未设置)".to_string())?;
    data_dir_from_home(Path::new(&home))
}

/// The monitor already captures a client home for each collection pass. Resolve
/// Cockpit from that same home while honoring the upstream's explicit settings.
pub fn data_dir_from_home(home: &Path) -> Result<PathBuf, String> {
    if let Some(path) = configured_directory()? {
        return Ok(path);
    }
    let dev = std::env::var("COCKPIT_TOOLS_PROFILE")
        .is_ok_and(|value| value.trim().eq_ignore_ascii_case("dev"));
    default_directory(home, dev)
}

fn default_directory(home: &Path, dev: bool) -> Result<PathBuf, String> {
    let current = home.join(if dev { ".cockpit_tools_dev" } else { ".cockpit_tools" });
    let legacy = home.join(if dev { ".antigravity_cockpit_dev" } else { ".antigravity_cockpit" });
    let current_present = metadata_if_present(&current)?.is_some();
    let legacy_present = metadata_if_present(&legacy)?.is_some();
    if legacy_present {
        if !legacy.is_dir() {
            return Err(format!("Cockpit 旧数据目录不可用: {}", legacy.display()));
        }
        if current_present {
            if let (Ok(current_target), Ok(legacy_target)) = (fs::canonicalize(&current), fs::canonicalize(&legacy)) {
                if current_target == legacy_target {
                    return Ok(current);
                }
            }
        }
        // Upstream retains the legacy store if two independent roots exist.
        // Do not combine their accounts, usage counters or collector checkpoints.
        return Ok(legacy);
    }
    if current_present && !current.is_dir() {
        return Err(format!("Cockpit 数据目录不可用: {}", current.display()));
    }
    Ok(current)
}

/// A captured physical store and the namespace of its retained local records.
/// Readers that persist facts must derive both source and destination from this
/// same context, even if directory selection changes before the batch finishes.
#[derive(Clone, Debug)]
pub struct SourceContext {
    pub data_dir: PathBuf,
    pub instance_id: String,
}

/// Only the historical physical legacy location owns the established `local`
/// namespace. An independent modern directory must not become `local` merely
/// because it is selected today. Official modern -> legacy aliases still resolve
/// to that same historical physical store; all other stores use a path digest.
pub fn source_context() -> Result<SourceContext, String> {
    let selected = crate::ledger_db::resolved_path_for_ownership(&data_dir()?)
        .map_err(|error| error.to_string())?;
    let home = std::env::var_os("USERPROFILE").filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("HOME").filter(|value| !value.is_empty()));
    // Resolve the home only, not the legacy entry: repointing a legacy alias at
    // a different physical source cannot grant that store the old account scope.
    let legacy = home.and_then(|home| crate::ledger_db::resolved_path_for_ownership(Path::new(&home)).ok())
        .map(|home| home.join(".antigravity_cockpit"));
    let identity_bytes = |path: &Path| {
        if cfg!(windows) {
            path.to_string_lossy().replace('\\', "/").to_ascii_lowercase().into_bytes()
        } else {
            path.as_os_str().as_encoded_bytes().to_vec()
        }
    };
    let instance_id = if legacy.as_ref().is_some_and(|path| identity_bytes(path) == identity_bytes(&selected)) {
        "local".to_string()
    } else {
        format!("cockpit:{:x}", md5::compute(identity_bytes(&selected)))
    };
    Ok(SourceContext { data_dir: selected, instance_id })
}

pub fn source_instance_id() -> Result<String, String> {
    Ok(source_context()?.instance_id)
}

/// Select our own persistence directory without modifying the upstream store.
pub fn local_state_dir(base: &Path) -> Result<PathBuf, String> {
    let identity = source_instance_id()?;
    local_state_dir_for_identity(base, &identity)
}

pub fn local_state_dir_for_identity(base: &Path, identity: &str) -> Result<PathBuf, String> {
    if identity == "local" {
        Ok(base.to_path_buf())
    } else {
        let digest = identity.strip_prefix("cockpit:").ok_or("Invalid Cockpit source identity")?;
        if digest.len() != 32 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("Invalid Cockpit source identity".to_string());
        }
        Ok(base.join("cockpit-sources").join(digest))
    }
}

fn metadata_if_present(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取 Cockpit 数据目录状态失败 ({}): {error}", path.display())),
    }
}

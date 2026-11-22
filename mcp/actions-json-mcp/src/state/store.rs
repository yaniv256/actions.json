use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use anyhow::{bail, Context, Result};
use rusqlite::Connection;

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};

/// Owner-protected SQLite state. Callers receive transactions through the
/// operation journal rather than sharing the connection directly.
#[derive(Clone)]
pub struct StateStore {
    path: PathBuf,
    connection: Arc<Mutex<Connection>>,
}

impl StateStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            create_protected_dir(parent)?;
        }
        refuse_symlink(&path)?;
        let connection = Connection::open(&path).context("open durable state database")?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "secure_delete", "ON")?;
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        #[cfg(windows)]
        protect_windows_path(&path, false)?;
        Ok(Self {
            path,
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn connection(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| anyhow::anyhow!("durable state lock poisoned"))
    }
}

pub(crate) fn create_protected_dir(path: &Path) -> Result<()> {
    refuse_symlink_components(path)?;
    if path.exists() {
        refuse_symlink(path)?;
        if !path.is_dir() {
            bail!("protected state parent is not a directory");
        }
    } else {
        fs::create_dir_all(path)?;
    }
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
        let metadata = fs::metadata(path)?;
        if metadata.uid() != unsafe { libc::geteuid() } {
            bail!("protected state directory is not owned by the current user");
        }
    }
    #[cfg(windows)]
    protect_windows_path(path, true)?;
    Ok(())
}

#[cfg(windows)]
fn protect_windows_path(path: &Path, directory: bool) -> Result<()> {
    use std::process::Command;
    let kind = if directory { "directory" } else { "file" };
    let script = r#"
$ErrorActionPreference='Stop'
$path=$env:ACTIONS_JSON_PROTECT_PATH
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:ACTIONS_JSON_PROTECT_KIND -eq 'directory') {
  $acl=New-Object System.Security.AccessControl.DirectorySecurity
  $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
} else {
  $acl=New-Object System.Security.AccessControl.FileSecurity
  $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')
}
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
$actual=Get-Acl -LiteralPath $path
if (-not $actual.AreAccessRulesProtected) { throw 'ACL inheritance remains enabled' }
$bad=@($actual.Access | Where-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value -or $_.AccessControlType -ne 'Allow' })
if ($bad.Count -ne 0) { throw 'non-owner ACL entries remain' }
"#;
    let output = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .env("ACTIONS_JSON_PROTECT_PATH", path)
        .env("ACTIONS_JSON_PROTECT_KIND", kind)
        .output()
        .with_context(|| format!("launch PowerShell ACL protection for {}", path.display()))?;
    if !output.status.success() {
        bail!(
            "failed to establish owner-only Windows ACL for {}: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

pub(crate) fn refuse_symlink(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            bail!("refusing symlink path: {}", path.display())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn refuse_symlink_components(path: &Path) -> Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                bail!("refusing symlink path component: {}", current.display())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::store::{create_protected_dir, refuse_symlink};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[derive(Debug, Clone)]
pub struct SpillPolicy {
    pub directory: PathBuf,
    pub inline_limit_bytes: usize,
    pub max_spill_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpillDescriptor {
    pub path: PathBuf,
    pub byte_size: u64,
    pub media_type: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResultSpill {
    Inline(Vec<u8>),
    Spilled(SpillDescriptor),
    Refused {
        byte_size: usize,
        max_spill_bytes: usize,
    },
}

impl ResultSpill {
    pub fn into_spilled(self) -> Result<SpillDescriptor> {
        match self {
            Self::Spilled(descriptor) => Ok(descriptor),
            Self::Inline(_) => bail!("spill policy unexpectedly returned inline output"),
            Self::Refused {
                byte_size,
                max_spill_bytes,
            } => {
                bail!("payload of {byte_size} bytes exceeds bounded spill limit {max_spill_bytes}")
            }
        }
    }
}

/// File extension for a spilled payload, so an image spill can be opened as an
/// image directly instead of as JSON that wraps base64.
fn extension_for(media_type: &str) -> &'static str {
    match media_type {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        _ => "json",
    }
}

impl SpillPolicy {
    pub fn persist(&self, name: &str, bytes: &[u8], media_type: &str) -> Result<ResultSpill> {
        if bytes.len() <= self.inline_limit_bytes {
            return Ok(ResultSpill::Inline(bytes.to_vec()));
        }
        if bytes.len() > self.max_spill_bytes {
            return Ok(ResultSpill::Refused {
                byte_size: bytes.len(),
                max_spill_bytes: self.max_spill_bytes,
            });
        }
        create_protected_dir(&self.directory)?;
        refuse_symlink(&self.directory)?;
        let safe_name: String = name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                    c
                } else {
                    '-'
                }
            })
            .take(80)
            .collect();
        let final_path = self.directory.join(format!(
            "{}-{safe_name}.{}",
            Uuid::new_v4(),
            extension_for(media_type)
        ));
        refuse_symlink(&final_path)?;
        let temp_path = self
            .directory
            .join(format!(".spill-{}.tmp", Uuid::new_v4()));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temp_path).context("create spill temporary")?;
        let write_result = (|| -> Result<()> {
            file.write_all(bytes)?;
            file.flush()?;
            file.sync_all()?;
            fs::rename(&temp_path, &final_path)?;
            #[cfg(unix)]
            fs::set_permissions(&final_path, fs::Permissions::from_mode(0o600))?;
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temp_path);
            let _ = fs::remove_file(&final_path);
            return Err(error);
        }
        let stored = fs::read(&final_path)?;
        if stored != bytes {
            let _ = fs::remove_file(&final_path);
            bail!("spill verification mismatch");
        }
        Ok(ResultSpill::Spilled(SpillDescriptor {
            path: final_path,
            byte_size: bytes.len() as u64,
            media_type: media_type.to_string(),
            sha256: format!("sha256:{:x}", Sha256::digest(bytes)),
        }))
    }

    pub fn delete(&self, descriptor: &SpillDescriptor) -> Result<()> {
        if descriptor.path.parent() != Some(self.directory.as_path()) {
            bail!("spill descriptor outside protected root");
        }
        refuse_symlink(&descriptor.path)?;
        match fs::remove_file(&descriptor.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.into()),
        }
    }
}

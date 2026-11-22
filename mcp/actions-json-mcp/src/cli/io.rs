use std::io::{self, Write};

use serde_json::Value;

/// Write exactly one JSON record. Broken pipes are ordinary pipeline shutdown,
/// not a diagnostic-worthy crash.
pub fn write_json(value: &Value) -> io::Result<bool> {
    let stdout = io::stdout();
    let mut lock = stdout.lock();
    let mut bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    bytes.push(b'\n');
    match lock.write_all(&bytes).and_then(|_| lock.flush()) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(false),
        Err(error) => Err(error),
    }
}

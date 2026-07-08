//! Extension identity verification — read the unpacked manifest and confirm the name.
//!
//! Ported from pipe_session.mjs line 84-85 / load_unpacked.mjs. Identity is verified by the
//! manifest **name**, never an id prefix (Chrome-assigned ids vary by path).

use std::path::Path;

/// The one manifest name that proves this is OUR extension.
pub const EXPECTED_NAME: &str = "actions.json Overlay Runtime";

/// Read `<ext_path>/manifest.json` and return (name, version). On read/parse failure, name is
/// None (caller treats a None/mismatch as an identity failure) and version carries the error.
pub fn read_manifest_identity(ext_path: &str) -> (Option<String>, Option<String>) {
    let manifest = Path::new(ext_path).join("manifest.json");
    match std::fs::read_to_string(&manifest) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(m) => (
                m.get("name").and_then(|v| v.as_str()).map(str::to_string),
                m.get("version").and_then(|v| v.as_str()).map(str::to_string),
            ),
            Err(e) => (None, Some(format!("manifest-parse-error: {e}"))),
        },
        Err(e) => (None, Some(format!("manifest-read-error: {e}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_manifest(dir: &std::path::Path, body: &str) {
        let mut f = std::fs::File::create(dir.join("manifest.json")).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    #[test]
    fn reads_name_and_version() {
        let dir = tempfile::tempdir().unwrap();
        write_manifest(dir.path(), r#"{"name":"actions.json Overlay Runtime","version":"0.1.185"}"#);
        let (name, version) = read_manifest_identity(dir.path().to_str().unwrap());
        assert_eq!(name.as_deref(), Some(EXPECTED_NAME));
        assert_eq!(version.as_deref(), Some("0.1.185"));
    }

    #[test]
    fn missing_manifest_yields_none_name_with_error_version() {
        let dir = tempfile::tempdir().unwrap();
        let (name, version) = read_manifest_identity(dir.path().to_str().unwrap());
        assert!(name.is_none());
        assert!(version.unwrap().contains("manifest-read-error"));
    }

    #[test]
    fn wrong_name_is_detectable_by_caller() {
        let dir = tempfile::tempdir().unwrap();
        write_manifest(dir.path(), r#"{"name":"Some Other Extension","version":"1.0"}"#);
        let (name, _) = read_manifest_identity(dir.path().to_str().unwrap());
        assert_ne!(name.as_deref(), Some(EXPECTED_NAME));
    }
}

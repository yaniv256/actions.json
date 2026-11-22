use actions_json_mcp::state::{ResultSpill, SpillPolicy};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

#[test]
fn large_result_is_atomic_owner_only_and_hash_verified() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("spills");
    let policy = SpillPolicy {
        directory: root.clone(),
        inline_limit_bytes: 4,
        max_spill_bytes: 1024,
    };
    let bytes = b"a bounded but larger result";
    let descriptor = match policy
        .persist("actions.site", bytes, "application/json")
        .unwrap()
    {
        ResultSpill::Spilled(v) => v,
        _ => panic!(),
    };
    assert_eq!(std::fs::read(&descriptor.path).unwrap(), bytes);
    assert_eq!(descriptor.byte_size, bytes.len() as u64);
    assert_eq!(
        descriptor.sha256,
        format!("sha256:{:x}", Sha256::digest(bytes))
    );
    assert!(std::fs::read_dir(&root).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".tmp")));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&descriptor.path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn oversized_result_refuses_without_inline_fallback() {
    let dir = tempdir().unwrap();
    let policy = SpillPolicy {
        directory: dir.path().join("spills"),
        inline_limit_bytes: 4,
        max_spill_bytes: 8,
    };
    assert!(matches!(
        policy
            .persist("tool", b"0123456789", "application/json")
            .unwrap(),
        ResultSpill::Refused {
            byte_size: 10,
            max_spill_bytes: 8
        }
    ));
}

#[cfg(unix)]
#[test]
fn symlink_spill_root_is_refused() {
    use std::os::unix::fs::symlink;
    let dir = tempdir().unwrap();
    let actual = dir.path().join("actual");
    std::fs::create_dir(&actual).unwrap();
    let linked = dir.path().join("linked");
    symlink(&actual, &linked).unwrap();
    let policy = SpillPolicy {
        directory: linked,
        inline_limit_bytes: 1,
        max_spill_bytes: 100,
    };
    assert!(policy
        .persist("tool", b"large", "application/json")
        .is_err());
    assert_eq!(std::fs::read_dir(&actual).unwrap().count(), 0);
}

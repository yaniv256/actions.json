//! Per-user resident runtime boundary.
//!
//! The resident is deliberately transport-neutral: U6 supplies the CLI
//! adapter and U7 supplies compatibility adapters, while this module owns the
//! single per-user authority, version handshake, lifecycle, and recovery.

pub mod ipc;
pub mod lifecycle;
pub mod recovery;

pub use ipc::{
    serve, BoxResponseFuture, Client, IngressAdapter, IngressContext, IpcRequest, IpcResponse,
    ResidentHandler, ServerControl, MAX_IPC_RECORD_BYTES,
};
pub use lifecycle::{
    begin_fenced_update, configuration_id, copy_on_write_migrate, endpoint_for, ensure_resident,
    probe, probe_status_any, read_status, restart_resident, stop_resident, FencedUpdate,
    ResidentConfig, ResidentStatus, StartDisposition,
};
pub use recovery::{recover_accepted_operations, ReceiptOracle, ReplayDispatcher, ReplayValidator};

/// Version of the private client/resident framing protocol. This is distinct
/// from the browser-extension and operation-envelope protocol versions.
pub const IPC_PROTOCOL_VERSION: u32 = 1;

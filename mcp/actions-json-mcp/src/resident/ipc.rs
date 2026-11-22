use std::{
    future::Future,
    path::Path,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, watch};

use super::{lifecycle::ResidentStatus, IPC_PROTOCOL_VERSION};

pub const MAX_IPC_RECORD_BYTES: usize = 8 * 1024 * 1024;
const CONNECTION_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

enum BoundedRecord {
    Eof,
    Data(Vec<u8>),
    TooLarge,
}

async fn read_bounded_record<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max_bytes: usize,
) -> std::io::Result<BoundedRecord> {
    let mut record = Vec::new();
    let mut too_large = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return if record.is_empty() && !too_large {
                Ok(BoundedRecord::Eof)
            } else if too_large {
                Ok(BoundedRecord::TooLarge)
            } else {
                Ok(BoundedRecord::Data(record))
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.unwrap_or(available.len());
        if !too_large {
            let remaining = max_bytes.saturating_sub(record.len());
            if take > remaining {
                record.extend_from_slice(&available[..remaining]);
                too_large = true;
            } else {
                record.extend_from_slice(&available[..take]);
            }
        }
        reader.consume(take + usize::from(newline.is_some()));
        if newline.is_some() {
            if record.last() == Some(&b'\r') {
                record.pop();
            }
            return if too_large {
                Ok(BoundedRecord::TooLarge)
            } else {
                Ok(BoundedRecord::Data(record))
            };
        }
    }
}

pub type BoxResponseFuture<'a> = Pin<Box<dyn Future<Output = Result<Value>> + Send + 'a>>;

pub trait ResidentHandler: Send + Sync + 'static {
    fn handle<'a>(&'a self, request: Value) -> BoxResponseFuture<'a>;

    fn handle_ingress<'a>(
        &'a self,
        request: Value,
        _ingress: IngressContext,
    ) -> BoxResponseFuture<'a> {
        self.handle(request)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngressAdapter {
    Cli,
    Mcp,
    Http,
    Unknown,
}

impl IngressAdapter {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::Mcp => "mcp",
            Self::Http => "http",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone)]
pub struct IngressContext {
    pub adapter: IngressAdapter,
    pub client_version: Option<String>,
}

impl IngressContext {
    pub fn unknown() -> Self {
        Self {
            adapter: IngressAdapter::Unknown,
            client_version: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IpcRequest {
    Handshake {
        protocol: u32,
        client_version: String,
    },
    Status,
    Operation {
        envelope: Value,
    },
    /// Adapter-authenticated operation. The adapter implementation sets this
    /// after parsing its external protocol; caller-provided `_adapter` fields
    /// inside `envelope` are never trusted for attribution.
    AdapterOperation {
        envelope: Value,
        adapter: IngressAdapter,
        #[serde(default)]
        client_version: Option<String>,
    },
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<ResidentStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<IpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IpcError {
    pub code: String,
    pub message: String,
}

impl IpcResponse {
    fn failure(code: &str, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            status: None,
            result: None,
            error: Some(IpcError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

#[derive(Debug)]
pub struct ServerControl {
    shutdown: broadcast::Sender<()>,
    stopped: watch::Receiver<bool>,
}

impl ServerControl {
    pub fn shutdown(&mut self) {
        let _ = self.shutdown.send(());
    }

    pub async fn wait_stopped(&mut self) {
        if *self.stopped.borrow() {
            return;
        }
        let _ = self.stopped.changed().await;
    }
}

#[derive(Debug, Clone)]
pub struct Client {
    endpoint: std::path::PathBuf,
    timeout: Duration,
}

impl Client {
    pub fn new(endpoint: impl Into<std::path::PathBuf>, timeout: Duration) -> Self {
        Self {
            endpoint: endpoint.into(),
            timeout,
        }
    }

    pub async fn request(&self, request: &IpcRequest) -> Result<IpcResponse> {
        tokio::time::timeout(self.timeout, request_once(&self.endpoint, request))
            .await
            .context("resident IPC timeout")?
    }

    pub async fn handshake(&self, client_version: &str) -> Result<ResidentStatus> {
        let response = self
            .request(&IpcRequest::Handshake {
                protocol: IPC_PROTOCOL_VERSION,
                client_version: client_version.to_owned(),
            })
            .await?;
        if !response.ok {
            bail!(
                "resident handshake refused: {}",
                response.error.map(|e| e.message).unwrap_or_default()
            );
        }
        response.status.context("resident handshake omitted status")
    }
}

#[cfg(unix)]
async fn request_once(endpoint: &Path, request: &IpcRequest) -> Result<IpcResponse> {
    let mut stream = tokio::net::UnixStream::connect(endpoint).await?;
    let mut bytes = serde_json::to_vec(request)?;
    if bytes.len() > MAX_IPC_RECORD_BYTES {
        bail!("payload_too_large: resident IPC request exceeds {MAX_IPC_RECORD_BYTES} bytes");
    }
    bytes.push(b'\n');
    stream.write_all(&bytes).await?;
    decode_response_record(
        read_bounded_record(&mut BufReader::new(stream), MAX_IPC_RECORD_BYTES).await?,
    )
}

#[cfg(windows)]
async fn request_once(endpoint: &Path, request: &IpcRequest) -> Result<IpcResponse> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let mut stream = ClientOptions::new().open(endpoint)?;
    let mut bytes = serde_json::to_vec(request)?;
    if bytes.len() > MAX_IPC_RECORD_BYTES {
        bail!("payload_too_large: resident IPC request exceeds {MAX_IPC_RECORD_BYTES} bytes");
    }
    bytes.push(b'\n');
    stream.write_all(&bytes).await?;
    decode_response_record(
        read_bounded_record(&mut BufReader::new(stream), MAX_IPC_RECORD_BYTES).await?,
    )
}

fn decode_response_record(record: BoundedRecord) -> Result<IpcResponse> {
    match record {
        BoundedRecord::Eof => bail!("resident closed IPC without a response"),
        BoundedRecord::TooLarge => {
            bail!("payload_too_large: resident IPC response exceeded {MAX_IPC_RECORD_BYTES} bytes")
        }
        BoundedRecord::Data(bytes) => {
            serde_json::from_slice(&bytes).context("decode resident IPC response")
        }
    }
}

#[cfg(unix)]
pub async fn serve(
    endpoint: impl AsRef<Path>,
    status: ResidentStatus,
    handler: Arc<dyn ResidentHandler>,
    idle_timeout: Option<Duration>,
) -> Result<ServerControl> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let endpoint = endpoint.as_ref().to_path_buf();
    if let Some(parent) = endpoint.parent() {
        crate::state::store::create_protected_dir(parent)?;
    }
    if let Ok(metadata) = std::fs::symlink_metadata(&endpoint) {
        if metadata.file_type().is_symlink() {
            bail!("refusing resident symlink endpoint");
        }
        if tokio::net::UnixStream::connect(&endpoint).await.is_ok() {
            bail!("resident endpoint is already active");
        }
        // No process accepts the protected endpoint, so this is a stale
        // socket from an interrupted owner process.
        std::fs::remove_file(&endpoint)?;
    }
    let listener = tokio::net::UnixListener::bind(&endpoint)?;
    std::fs::set_permissions(&endpoint, std::fs::Permissions::from_mode(0o600))?;
    let metadata = std::fs::metadata(&endpoint)?;
    if metadata.uid() != unsafe { libc::geteuid() } {
        bail!("resident endpoint is not user-owned");
    }

    let (shutdown_tx, mut shutdown_rx) = broadcast::channel(2);
    let shutdown_for_tasks = shutdown_tx.clone();
    let active_connections = Arc::new(AtomicUsize::new(0));
    let (stopped_tx, stopped_rx) = watch::channel(false);
    let endpoint_cleanup = endpoint.clone();
    tokio::spawn(async move {
        let run = async {
            loop {
                let accepted = if let Some(timeout) = idle_timeout {
                    tokio::select! {
                        _ = shutdown_rx.recv() => break,
                        value = tokio::time::timeout(timeout, listener.accept()) => match value {
                            Ok(value) => value,
                            Err(_) if active_connections.load(Ordering::Acquire) == 0 => break,
                            Err(_) => continue,
                        },
                    }
                } else {
                    tokio::select! { _ = shutdown_rx.recv() => break, value = listener.accept() => value }
                };
                let (stream, _) = match accepted {
                    Ok(value) => value,
                    Err(_) => break,
                };
                let peer = match stream.peer_cred() {
                    Ok(peer) => peer,
                    Err(_) => continue,
                };
                if peer.uid() != unsafe { libc::geteuid() } {
                    continue;
                }
                let handler = handler.clone();
                let status = status.clone();
                let shutdown = shutdown_for_tasks.clone();
                let active_connections = active_connections.clone();
                active_connections.fetch_add(1, Ordering::AcqRel);
                tokio::spawn(async move {
                    let _ = handle_stream(stream, status, handler, shutdown).await;
                    active_connections.fetch_sub(1, Ordering::AcqRel);
                });
            }
        };
        run.await;
        let _ = std::fs::remove_file(endpoint_cleanup);
        let _ = stopped_tx.send(true);
    });
    Ok(ServerControl {
        shutdown: shutdown_tx,
        stopped: stopped_rx,
    })
}

#[cfg(unix)]
async fn handle_stream(
    stream: tokio::net::UnixStream,
    status: ResidentStatus,
    handler: Arc<dyn ResidentHandler>,
    shutdown: broadcast::Sender<()>,
) -> Result<()> {
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    loop {
        let record = match tokio::time::timeout(
            CONNECTION_IDLE_TIMEOUT,
            read_bounded_record(&mut reader, MAX_IPC_RECORD_BYTES),
        )
        .await
        {
            Err(_) => break,
            Ok(value) => value?,
        };
        let line = match record {
            BoundedRecord::Eof => break,
            BoundedRecord::TooLarge => {
                write_response(
                    &mut writer,
                    IpcResponse::failure(
                        "payload_too_large",
                        format!("resident IPC record exceeds {MAX_IPC_RECORD_BYTES} bytes"),
                    ),
                )
                .await?;
                continue;
            }
            BoundedRecord::Data(line) => line,
        };
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let response = match serde_json::from_slice::<IpcRequest>(&line) {
            Err(error) => IpcResponse::failure("invalid_request", error.to_string()),
            Ok(IpcRequest::Handshake {
                protocol,
                client_version,
            }) => {
                if protocol != IPC_PROTOCOL_VERSION {
                    IpcResponse::failure(
                        "protocol_mismatch",
                        format!("client {protocol}; resident {}", IPC_PROTOCOL_VERSION),
                    )
                } else if client_version != status.executable_version {
                    IpcResponse::failure(
                        "version_mismatch",
                        format!(
                            "client {client_version}; resident {}",
                            status.executable_version
                        ),
                    )
                } else {
                    IpcResponse {
                        ok: true,
                        status: Some(status.clone()),
                        result: None,
                        error: None,
                    }
                }
            }
            Ok(IpcRequest::Status) => IpcResponse {
                ok: true,
                status: Some(status.clone()),
                result: None,
                error: None,
            },
            Ok(IpcRequest::Operation { envelope }) => match handler
                .handle_ingress(envelope, IngressContext::unknown())
                .await
            {
                Ok(result) => IpcResponse {
                    ok: true,
                    status: None,
                    result: Some(result),
                    error: None,
                },
                Err(error) => IpcResponse::failure("operation_failed", error.to_string()),
            },
            Ok(IpcRequest::AdapterOperation {
                envelope,
                adapter,
                client_version,
            }) => match handler
                .handle_ingress(
                    envelope,
                    IngressContext {
                        adapter,
                        client_version,
                    },
                )
                .await
            {
                Ok(result) => IpcResponse {
                    ok: true,
                    status: None,
                    result: Some(result),
                    error: None,
                },
                Err(error) => IpcResponse::failure("operation_failed", error.to_string()),
            },
            Ok(IpcRequest::Shutdown) => {
                let _ = shutdown.send(());
                IpcResponse {
                    ok: true,
                    status: Some(status.clone()),
                    result: None,
                    error: None,
                }
            }
        };
        write_response(&mut writer, response).await?;
    }
    Ok(())
}

async fn write_response<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    response: IpcResponse,
) -> Result<()> {
    let mut bytes = serde_json::to_vec(&response)?;
    if bytes.len() > MAX_IPC_RECORD_BYTES {
        bytes = serde_json::to_vec(&IpcResponse::failure(
            "payload_too_large",
            format!("resident IPC response exceeds {MAX_IPC_RECORD_BYTES} bytes"),
        ))?;
    }
    bytes.push(b'\n');
    writer.write_all(&bytes).await?;
    Ok(())
}

#[cfg(windows)]
pub async fn serve(
    endpoint: impl AsRef<Path>,
    status: ResidentStatus,
    handler: Arc<dyn ResidentHandler>,
    idle_timeout: Option<Duration>,
) -> Result<ServerControl> {
    use tokio::net::windows::named_pipe::ServerOptions;

    let pipe_name = endpoint.as_ref().to_path_buf();
    let first = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(&pipe_name)
        .context("create first resident named-pipe instance")?;
    let (shutdown_tx, mut shutdown_rx) = broadcast::channel(2);
    let shutdown_for_tasks = shutdown_tx.clone();
    let active_connections = Arc::new(AtomicUsize::new(0));
    let (stopped_tx, stopped_rx) = watch::channel(false);
    tokio::spawn(async move {
        let mut current = first;
        loop {
            let connected = if let Some(timeout) = idle_timeout {
                tokio::select! {
                    _ = shutdown_rx.recv() => break,
                    value = tokio::time::timeout(timeout, current.connect()) => match value {
                        Ok(value) => value,
                        Err(_) if active_connections.load(Ordering::Acquire) == 0 => break,
                        Err(_) => continue,
                    }
                }
            } else {
                tokio::select! { _ = shutdown_rx.recv() => break, value = current.connect() => value }
            };
            if connected.is_err() {
                break;
            }
            let accepted = current;
            current = match ServerOptions::new()
                .reject_remote_clients(true)
                .create(&pipe_name)
            {
                Ok(server) => server,
                Err(_) => break,
            };
            if !windows_peer_is_current_user(&accepted) {
                continue;
            }
            let handler = handler.clone();
            let status = status.clone();
            let shutdown = shutdown_for_tasks.clone();
            let active_connections = active_connections.clone();
            active_connections.fetch_add(1, Ordering::AcqRel);
            tokio::spawn(async move {
                let _ = handle_windows_stream(accepted, status, handler, shutdown).await;
                active_connections.fetch_sub(1, Ordering::AcqRel);
            });
        }
        let _ = stopped_tx.send(true);
    });
    Ok(ServerControl {
        shutdown: shutdown_tx,
        stopped: stopped_rx,
    })
}

#[cfg(windows)]
fn windows_peer_is_current_user(pipe: &tokio::net::windows::named_pipe::NamedPipeServer) -> bool {
    use std::{ffi::c_void, os::windows::io::AsRawHandle, ptr};
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        Security::{EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER},
        System::{
            Pipes::GetNamedPipeClientProcessId,
            Threading::{
                GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
    };

    unsafe fn user_sid_for_process(
        process: windows_sys::Win32::Foundation::HANDLE,
    ) -> Option<Vec<u8>> {
        let mut token = ptr::null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut length = 0u32;
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut length);
        if length == 0 {
            CloseHandle(token);
            return None;
        }
        let mut buffer = vec![0u8; length as usize];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast::<c_void>(),
            length,
            &mut length,
        );
        CloseHandle(token);
        if ok == 0 {
            None
        } else {
            Some(buffer)
        }
    }

    unsafe {
        let mut pid = 0u32;
        if GetNamedPipeClientProcessId(pipe.as_raw_handle() as _, &mut pid) == 0 {
            return false;
        }
        let client_process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if client_process.is_null() {
            return false;
        }
        let current = user_sid_for_process(GetCurrentProcess());
        let client = user_sid_for_process(client_process);
        CloseHandle(client_process);
        match (current, client) {
            (Some(current), Some(client)) => {
                let current_user = &*(current.as_ptr().cast::<TOKEN_USER>());
                let client_user = &*(client.as_ptr().cast::<TOKEN_USER>());
                EqualSid(current_user.User.Sid, client_user.User.Sid) != 0
            }
            _ => false,
        }
    }
}

#[cfg(windows)]
async fn handle_windows_stream(
    stream: tokio::net::windows::named_pipe::NamedPipeServer,
    status: ResidentStatus,
    handler: Arc<dyn ResidentHandler>,
    shutdown: broadcast::Sender<()>,
) -> Result<()> {
    let (reader, mut writer) = tokio::io::split(stream);
    let mut reader = BufReader::new(reader);
    loop {
        let record = match tokio::time::timeout(
            CONNECTION_IDLE_TIMEOUT,
            read_bounded_record(&mut reader, MAX_IPC_RECORD_BYTES),
        )
        .await
        {
            Err(_) => break,
            Ok(value) => value?,
        };
        let line = match record {
            BoundedRecord::Eof => break,
            BoundedRecord::TooLarge => {
                write_response(
                    &mut writer,
                    IpcResponse::failure(
                        "payload_too_large",
                        format!("resident IPC record exceeds {MAX_IPC_RECORD_BYTES} bytes"),
                    ),
                )
                .await?;
                continue;
            }
            BoundedRecord::Data(line) => line,
        };
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let response = match serde_json::from_slice::<IpcRequest>(&line) {
            Err(error) => IpcResponse::failure("invalid_request", error.to_string()),
            Ok(IpcRequest::Handshake {
                protocol,
                client_version,
            }) => {
                if protocol != IPC_PROTOCOL_VERSION {
                    IpcResponse::failure("protocol_mismatch", "resident IPC protocol mismatch")
                } else if client_version != status.executable_version {
                    IpcResponse::failure("version_mismatch", "resident executable version mismatch")
                } else {
                    IpcResponse {
                        ok: true,
                        status: Some(status.clone()),
                        result: None,
                        error: None,
                    }
                }
            }
            Ok(IpcRequest::Status) => IpcResponse {
                ok: true,
                status: Some(status.clone()),
                result: None,
                error: None,
            },
            Ok(IpcRequest::Operation { envelope }) => match handler
                .handle_ingress(envelope, IngressContext::unknown())
                .await
            {
                Ok(result) => IpcResponse {
                    ok: true,
                    status: None,
                    result: Some(result),
                    error: None,
                },
                Err(error) => IpcResponse::failure("operation_failed", error.to_string()),
            },
            Ok(IpcRequest::AdapterOperation {
                envelope,
                adapter,
                client_version,
            }) => match handler
                .handle_ingress(
                    envelope,
                    IngressContext {
                        adapter,
                        client_version,
                    },
                )
                .await
            {
                Ok(result) => IpcResponse {
                    ok: true,
                    status: None,
                    result: Some(result),
                    error: None,
                },
                Err(error) => IpcResponse::failure("operation_failed", error.to_string()),
            },
            Ok(IpcRequest::Shutdown) => {
                let _ = shutdown.send(());
                IpcResponse {
                    ok: true,
                    status: Some(status.clone()),
                    result: None,
                    error: None,
                }
            }
        };
        write_response(&mut writer, response).await?;
    }
    Ok(())
}

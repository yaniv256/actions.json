use std::sync::Arc;
use std::time::Duration;

use actions_json_mcp::mcp_adapter::{McpToolCall, ResidentMcpClient};
use actions_json_mcp::resident::{
    self, BoxResponseFuture, IngressAdapter, IngressContext, ResidentHandler, ResidentStatus,
    MAX_IPC_RECORD_BYTES,
};
use anyhow::Result;
use serde_json::{json, Value};
use tokio::sync::Mutex;

#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Default)]
struct Capture {
    calls: Mutex<Vec<(Value, IngressContext)>>,
}

impl ResidentHandler for Capture {
    fn handle<'a>(&'a self, request: Value) -> BoxResponseFuture<'a> {
        self.handle_ingress(request, IngressContext::unknown())
    }

    fn handle_ingress<'a>(
        &'a self,
        request: Value,
        ingress: IngressContext,
    ) -> BoxResponseFuture<'a> {
        Box::pin(async move {
            self.calls.lock().await.push((request.clone(), ingress));
            Ok(json!({"ok": true, "request": request}))
        })
    }
}

#[test]
fn mcp_envelope_preserves_canonical_routing_and_drops_forged_attribution() {
    let envelope = McpToolCall::from_params(json!({
        "name": "trello.card.open",
        "arguments": {"title": "Maximum pain"},
        "request_id": "req-parity-1",
        "profile": "agent-a",
        "profile_token": "profile-token",
        "target_id": "tab-7",
        "catalog_revision": "catalog-3",
        "lease_token": "lease-2",
        "_adapter": "cli",
        "_client_version": "forged"
    }))
    .expect("valid MCP operation")
    .into_envelope();

    assert_eq!(envelope["name"], "trello.card.open");
    assert_eq!(envelope["request_id"], "req-parity-1");
    assert_eq!(envelope["profile"], "agent-a");
    assert_eq!(envelope["target_id"], "tab-7");
    assert_eq!(envelope["catalog_revision"], "catalog-3");
    assert_eq!(envelope["lease_token"], "lease-2");
    assert!(envelope.get("_adapter").is_none());
    assert!(envelope.get("_client_version").is_none());
}

#[tokio::test]
async fn mcp_client_supplies_transport_authenticated_ingress_context() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let endpoint = resident::endpoint_for(temp.path());
    let capture = Arc::new(Capture::default());
    let mut server = resident::serve(
        &endpoint,
        ResidentStatus::current("adapter-test"),
        capture.clone(),
        Some(Duration::from_secs(5)),
    )
    .await?;

    let client = resident::Client::new(endpoint, Duration::from_secs(2));
    client.handshake("adapter-test").await?;
    let mcp = ResidentMcpClient::new(client, "adapter-test");
    let result = mcp
        .execute(json!({
            "name": "resident.system.status",
            "request_id": "req-parity-2",
            "_adapter": "http",
            "_client_version": "forged"
        }))
        .await
        .map_err(anyhow::Error::msg)?;
    assert_eq!(result["ok"], true);

    let calls = capture.calls.lock().await;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].1.adapter, IngressAdapter::Mcp);
    assert_eq!(calls[0].1.client_version.as_deref(), Some("adapter-test"));

    drop(calls);
    server.shutdown();
    server.wait_stopped().await;
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn resident_bounds_one_record_and_keeps_the_connection_usable() -> Result<()> {
    let temp = tempfile::tempdir()?;
    let endpoint = resident::endpoint_for(temp.path());
    let capture = Arc::new(Capture::default());
    let mut server = resident::serve(
        &endpoint,
        ResidentStatus::current("adapter-test"),
        capture,
        Some(Duration::from_secs(5)),
    )
    .await?;

    let stream = tokio::net::UnixStream::connect(&endpoint).await?;
    let (reader, mut writer) = stream.into_split();
    let mut oversized = vec![b'x'; MAX_IPC_RECORD_BYTES + 1];
    oversized.push(b'\n');
    writer.write_all(&oversized).await?;
    writer.write_all(b"{\"type\":\"status\"}\n").await?;

    let mut lines = BufReader::new(reader).lines();
    let first: Value = serde_json::from_str(&lines.next_line().await?.unwrap())?;
    let second: Value = serde_json::from_str(&lines.next_line().await?.unwrap())?;
    assert_eq!(first["ok"], false);
    assert_eq!(first["error"]["code"], "payload_too_large");
    assert_eq!(second["ok"], true);
    assert_eq!(second["status"]["executable_version"], "adapter-test");

    server.shutdown();
    server.wait_stopped().await;
    Ok(())
}

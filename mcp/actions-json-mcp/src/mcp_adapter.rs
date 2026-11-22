use serde_json::{json, Value};

use crate::{
    operation::OperationRequest,
    resident::{Client, IngressAdapter, IpcRequest},
};

#[derive(Debug, Clone)]
pub struct McpToolCall {
    request: OperationRequest,
    envelope: Value,
}

impl McpToolCall {
    pub fn from_params(params: Value) -> Result<Self, String> {
        let object = params
            .as_object()
            .ok_or_else(|| "tools/call params must be an object".to_string())?;
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| "tools/call requires params.name".to_string())?;
        let arguments = object
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !arguments.is_object() {
            return Err("tools/call arguments must be an object".into());
        }
        let string_field = |key: &str| -> Result<Option<String>, String> {
            match object.get(key) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(value)) => Ok(Some(value.clone())),
                Some(_) => Err(format!("tools/call {key} must be a string")),
            }
        };
        let target_runtime_id = string_field("target_runtime_id")?.or_else(|| {
            arguments
                .get("target_runtime_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        let target_url_contains = string_field("target_url_contains")?.or_else(|| {
            arguments
                .get("target_url_contains")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        let timeout_ms = object
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .or_else(|| arguments.get("timeout_ms").and_then(Value::as_u64))
            .unwrap_or(30_000);
        let request = OperationRequest {
            name: name.into(),
            arguments: arguments.clone(),
            target_runtime_id: target_runtime_id.clone(),
            target_url_contains: target_url_contains.clone(),
            timeout_ms,
        };
        let mut envelope = json!({
            "name": name,
            "arguments": arguments,
            "timeout_ms": timeout_ms,
            "request_id": object.get("request_id").and_then(Value::as_str)
                .map(str::to_string).unwrap_or_else(|| format!("ajm_{}", uuid::Uuid::new_v4().simple())),
        });
        let output = envelope.as_object_mut().expect("object envelope");
        for key in [
            "profile",
            "profile_token",
            "target_id",
            "target_generation",
            "catalog_revision",
            "lease_token",
            "output_policy",
        ] {
            if let Some(value) = object.get(key) {
                output.insert(key.to_string(), value.clone());
            }
        }
        if let Some(value) = target_runtime_id {
            output.insert("target_runtime_id".into(), json!(value));
        }
        if let Some(value) = target_url_contains {
            output.insert("target_url_contains".into(), json!(value));
        }
        Ok(Self { request, envelope })
    }

    pub fn into_request(self) -> OperationRequest {
        self.request
    }

    pub fn into_envelope(self) -> Value {
        self.envelope
    }
}

#[derive(Debug, Clone)]
pub struct ResidentMcpClient {
    client: Client,
    client_version: String,
}

impl ResidentMcpClient {
    pub fn new(client: Client, client_version: impl Into<String>) -> Self {
        Self {
            client,
            client_version: client_version.into(),
        }
    }

    pub async fn execute(&self, envelope: Value) -> Result<Value, String> {
        let response = self
            .client
            .request(&IpcRequest::AdapterOperation {
                envelope,
                adapter: IngressAdapter::Mcp,
                client_version: Some(self.client_version.clone()),
            })
            .await
            .map_err(|error| error.to_string())?;
        if !response.ok {
            return Err(response
                .error
                .map(|error| error.message)
                .unwrap_or_else(|| "resident refused MCP operation".into()));
        }
        response
            .result
            .ok_or_else(|| "resident omitted MCP operation result".into())
    }
}

pub fn render_tool_result(result: &Value) -> Value {
    let is_error = result.get("ok").and_then(Value::as_bool) == Some(false);
    json!({
        "content": [{
            "type": "text",
            "text": serde_json::to_string_pretty(result).unwrap_or_else(|_| result.to_string()),
        }],
        "isError": is_error,
    })
}

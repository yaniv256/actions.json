#[tokio::main]
async fn main() -> anyhow::Result<()> {
    actions_json_mcp::run_cli().await
}

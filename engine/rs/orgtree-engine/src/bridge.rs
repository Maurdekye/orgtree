//! `orgtree-engine mcp-bridge`: a stdio MCP server for CLIs that can only
//! launch MCP servers as processes. It relays JSON-RPC lines to the engine
//! over a named pipe, identifying the agent with its per-process token.

use std::process::ExitCode;

pub fn run(_args: &[String]) -> ExitCode {
    eprintln!("orgtree-engine mcp-bridge: not available in this build yet");
    ExitCode::from(1)
}

//! The channel: length-prefixed JSON frames over loopback TCP
//! (CONTRACT-M1 §9). Each frame is a big-endian u32 length followed by that
//! many bytes of UTF-8 JSON. The first client frame is `{"hello": <token>}`;
//! the server answers with the handshake or closes the socket.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Frames larger than this are refused (and the connection closed).
pub const MAX_FRAME: u32 = 4 * 1024 * 1024;

pub const PROTOCOL: &str = "orgtree.p03-store/v1";

pub async fn read_frame<R: AsyncReadExt + Unpin>(r: &mut R) -> std::io::Result<Option<Value>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_be_bytes(len);
    if n > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, format!("frame of {n} bytes exceeds {MAX_FRAME}")));
    }
    let mut buf = vec![0u8; n as usize];
    r.read_exact(&mut buf).await?;
    serde_json::from_slice(&buf).map(Some).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

pub async fn write_frame<W: AsyncWriteExt + Unpin>(w: &mut W, v: &Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(v).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    if bytes.len() as u64 > MAX_FRAME as u64 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "response frame too large"));
    }
    w.write_all(&(bytes.len() as u32).to_be_bytes()).await?;
    w.write_all(&bytes).await?;
    w.flush().await
}

/// What the door binds after authenticating the caller (CONTRACT-M1 §9).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct WireBinding {
    /// "agent" | "operator" | "user" | "system"
    pub principal_kind: String,
    pub principal: Option<uuid::Uuid>,
    pub generation: Option<i64>,
    pub acting: Option<uuid::Uuid>,
    /// Caller key; absent for keyless doors (the service mints one, E4).
    pub key: Option<String>,
    /// Harness tag; honoured only by a qualification build.
    #[serde(default)]
    pub op_tag: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Request {
    pub verb: String,
    pub org: uuid::Uuid,
    pub binding: WireBinding,
    #[serde(default)]
    pub args: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Handshake {
    pub protocol: String,
    pub qualification: bool,
    pub build_sha: String,
    pub verbs: Vec<String>,
    pub points: Vec<String>,
    pub controls: Vec<String>,
}

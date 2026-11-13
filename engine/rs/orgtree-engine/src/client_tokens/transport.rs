//! Retain one OS shutdown handle across HTTP keepalive and WebSocket upgrade.
use std::io;
use std::net::{Shutdown, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::task::{Context, Poll};

use axum::extract::connect_info::Connected;
use axum::serve::{IncomingStream, Listener};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};

pub struct Connection {
    pub peer: SocketAddr,
    /// It came in through a hosting desktop's remote door (`remote_access/door.rs`), never
    /// through the listener the app itself uses. Set where the connection is accepted and
    /// nowhere else: the request guard decides by it which tokens may be presented at all.
    pub door: bool,
    socket: std::net::TcpStream,
    closed: AtomicBool,
}

#[nolog]
impl Connection {
    /// The engine's handle on one accepted connection, and the stream to serve it on.
    pub(crate) fn accept(stream: TcpStream, peer: SocketAddr, door: bool) -> io::Result<ClientIo> {
        let socket = stream.into_std()?;
        let handle = socket.try_clone()?;
        Ok(ClientIo { stream: TcpStream::from_std(socket)?,
            connection: Arc::new(Connection { peer, door, socket: handle, closed: AtomicBool::new(false) }) })
    }
    pub fn closed(&self) -> bool { self.closed.load(Ordering::Acquire) }
    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

#[derive(Clone)]
pub struct ClientInfo(pub Arc<Connection>);

pub struct ClientIo {
    stream: TcpStream,
    connection: Arc<Connection>,
}

pub struct ClientListener(pub TcpListener);

impl Listener for ClientListener {
    type Io = ClientIo;
    type Addr = SocketAddr;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match self.0.accept().await.and_then(|(stream, peer)| Ok((Connection::accept(stream, peer, false)?, peer))) {
                Ok(pair) => return pair,
                Err(error) => {
                    tracing::warn!(error = %error, "standalone accept failed");
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            }
        }
    }
    fn local_addr(&self) -> io::Result<SocketAddr> { self.0.local_addr() }
}

impl Connected<IncomingStream<'_, ClientListener>> for ClientInfo {
    fn connect_info(stream: IncomingStream<'_, ClientListener>) -> Self { Self(stream.io().connection.clone()) }
}

impl ClientIo {
    /// The connection this stream serves.
    pub(crate) fn connection(&self) -> &Arc<Connection> { &self.connection }
}

impl AsyncRead for ClientIo {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buf)
    }
}

impl AsyncWrite for ClientIo {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stream).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> { Pin::new(&mut self.stream).poll_flush(cx) }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> { Pin::new(&mut self.stream).poll_shutdown(cx) }
}

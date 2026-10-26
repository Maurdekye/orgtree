//! Playback only, after nodes::file's ordinary org/node/path authorization.
//! Private file/headers and stream bodies never enter argument/return tracing.
use axum::body::Body;
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

pub const MAX_BYTES: u64 = 256 * 1024 * 1024;

#[cfg_attr(not(test), orgtree_logged::nolog)]
pub(crate) fn media_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "ogg" => Some("audio/ogg"),
        "m4a" => Some("audio/mp4"),
        "aac" => Some("audio/aac"),
        "flac" => Some("audio/flac"),
        _ => None,
    }
}

/// One inclusive byte range. Multipart and malformed requests refuse explicitly.
#[cfg_attr(not(test), orgtree_logged::nolog)]
fn byte_range(raw: &str, size: u64) -> Option<(u64, u64)> {
    let (left, right) = raw.strip_prefix("bytes=")?.split_once('-')?;
    let number = |s: &str| {
        if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
            s.parse::<u64>().ok()
        } else {
            None
        }
    };
    if size == 0 {
        return None;
    }
    if left.is_empty() {
        let count = number(right)?;
        return (count > 0).then(|| (size.saturating_sub(count), size - 1));
    }
    let start = number(left)?;
    let end = if right.is_empty() {
        size - 1
    } else {
        number(right)?.min(size - 1)
    };
    (start < size && start <= end).then_some((start, end))
}

#[cfg_attr(not(test), orgtree_logged::nolog)]
pub async fn serve(path: &Path, range: Option<&str>) -> Result<Response, StatusCode> {
    let mime = media_type(path).ok_or(StatusCode::UNSUPPORTED_MEDIA_TYPE)?;
    if !tokio::fs::metadata(path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?
        .is_file()
    {
        return Err(StatusCode::NOT_FOUND);
    }
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    serve_opened(file,mime,range,None).await
}

/// App files arrive as an already authorized, no-reparse handle. Do not reopen
/// their private path. Cancellation ends active bodies when their running copy's
/// links end (power off, code change, delete, deny, revoke or removed access);
/// the original node-media path retains its unchanged behavior.
#[cfg_attr(not(test), orgtree_logged::nolog)]
pub(crate) async fn serve_opened(mut file:tokio::fs::File,mime:&'static str,range:Option<&str>,cancel:Option<tokio_util::sync::CancellationToken>)->Result<Response,StatusCode>{
    let meta = file.metadata().await.map_err(|_| StatusCode::NOT_FOUND)?;
    if !meta.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }
    let size = meta.len();
    if size > MAX_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let (status, start, len) = match range {
        Some(raw) => match byte_range(raw, size) {
            Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end - start + 1),
            None => {
                return Ok((
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    [
                        (header::CONTENT_RANGE, format!("bytes */{size}")),
                        (header::CACHE_CONTROL, "no-store".into()),
                    ],
                )
                    .into_response())
            }
        },
        None => (StatusCode::OK, 0, size),
    };
    file.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    // Bound allocation and output, even if a writer grows the file after metadata.
    let stream = ReaderStream::with_capacity(file.take(len), 64 * 1024);
    let body=if let Some(cancel)=cancel{
        use futures::StreamExt;
        Body::from_stream(stream.take_until(async move{cancel.cancelled().await}))
    }else{Body::from_stream(stream)};
    let mut response = body.into_response();
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, mime.parse().unwrap());
    headers.insert(header::CONTENT_LENGTH, len.to_string().parse().unwrap());
    headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    headers.insert(header::CONTENT_DISPOSITION, "inline".parse().unwrap());
    if status == StatusCode::PARTIAL_CONTENT {
        headers.insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{size}", start + len - 1)
                .parse()
                .unwrap(),
        );
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use std::sync::atomic::{AtomicU64, Ordering};
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new(ext: &str, bytes: &[u8]) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let p = std::env::temp_dir().join(format!(
                "media-card-{}-{}.{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed),
                ext
            ));
            let mut f = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&p)
                .unwrap();
            std::io::Write::write_all(&mut f, bytes).unwrap();
            Self(p)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    #[test]
    fn ranges_accept_open_suffix_and_clamped_ends() {
        for (raw, result) in [
            ("bytes=0-3", (0, 3)),
            ("bytes=5-", (5, 9)),
            ("bytes=-3", (7, 9)),
            ("bytes=-99", (0, 9)),
            ("bytes=8-99", (8, 9)),
        ] {
            assert_eq!(byte_range(raw, 10), Some(result));
        }
    }
    #[test]
    fn ranges_reject_multipart_overflow_and_invalid_bounds() {
        for raw in [
            "bytes=10-",
            "bytes=3-2",
            "bytes=-0",
            "bytes=0-1,3-4",
            "bytes=+1-2",
            "bytes=0-18446744073709551616",
            "words=0-1",
            "bytes=0--1",
            "bytes= 0-1",
        ] {
            assert_eq!(byte_range(raw, 10), None, "{raw}");
        }
        assert_eq!(byte_range("bytes=0-", 0), None);
    }
    #[test]
    fn format_allowlist_excludes_active_documents() {
        for name in [
            "clip.MP4",
            "clip.webm",
            "sound.mp3",
            "sound.wav",
            "sound.ogg",
            "sound.m4a",
            "sound.aac",
            "sound.flac",
        ] {
            assert!(media_type(Path::new(name)).is_some());
        }
        for name in ["index.html", "image.svg", "script.js", "file", "movie.exe"] {
            assert!(media_type(Path::new(name)).is_none());
        }
    }
    #[tokio::test]
    async fn partial_stream_has_exact_bytes_and_private_headers() {
        let f = Fixture::new("webm", b"0123456789");
        let r = serve(&f.0, Some("bytes=2-5")).await.unwrap();
        assert_eq!(r.status(), 206);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(r.headers()[header::CONTENT_TYPE], "video/webm");
        assert_eq!(r.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(r.headers()[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(
            r.into_body().collect().await.unwrap().to_bytes().as_ref(),
            b"2345"
        );
    }
    #[tokio::test]
    async fn full_stream_stops_at_the_opened_size_snapshot() {
        let f = Fixture::new("wav", b"original");
        let r = serve(&f.0, None).await.unwrap();
        std::fs::OpenOptions::new()
            .append(true)
            .open(&f.0)
            .unwrap()
            .write_all(b"later")
            .unwrap();
        assert_eq!(r.status(), 200);
        assert_eq!(r.headers()[header::CONTENT_LENGTH], "8");
        assert_eq!(
            r.into_body().collect().await.unwrap().to_bytes().as_ref(),
            b"original"
        );
    }
    #[tokio::test]
    async fn empty_and_invalid_ranges_return_416_without_body() {
        let f = Fixture::new("mp3", b"");
        let r = serve(&f.0, Some("bytes=0-")).await.unwrap();
        assert_eq!(r.status(), 416);
        assert_eq!(r.headers()[header::CONTENT_RANGE], "bytes */0");
        assert!(r.into_body().collect().await.unwrap().to_bytes().is_empty());
    }
    #[tokio::test]
    async fn oversized_missing_and_wrong_format_refuse_before_streaming() {
        let f = Fixture::new("mp4", b"");
        std::fs::OpenOptions::new()
            .write(true)
            .open(&f.0)
            .unwrap()
            .set_len(MAX_BYTES + 1)
            .unwrap();
        assert_eq!(
            serve(&f.0, None).await.unwrap_err(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        let wrong = Fixture::new("html", b"<script>never execute</script>");
        assert_eq!(
            serve(&wrong.0, None).await.unwrap_err(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(
            serve(&f.0.with_extension("webm"), None).await.unwrap_err(),
            StatusCode::NOT_FOUND
        );
    }
    use std::io::Write;
    #[tokio::test]
    async fn app_files_opened_stream_preserves_ranges_and_cancels_revoked_bodies(){
        let f=Fixture::new("mp4",b"0123456789");
        let cancel=tokio_util::sync::CancellationToken::new();
        let r=serve_opened(tokio::fs::File::open(&f.0).await.unwrap(),"video/mp4",Some("bytes=2-5"),Some(cancel.clone())).await.unwrap();
        assert_eq!(r.status(),206);assert_eq!(r.headers()[header::CONTENT_RANGE],"bytes 2-5/10");
        assert_eq!(r.into_body().collect().await.unwrap().to_bytes().as_ref(),b"2345");
        let r=serve_opened(tokio::fs::File::open(&f.0).await.unwrap(),"video/mp4",None,Some(cancel.clone())).await.unwrap();
        cancel.cancel();assert!(r.into_body().collect().await.unwrap().to_bytes().is_empty());
    }
}

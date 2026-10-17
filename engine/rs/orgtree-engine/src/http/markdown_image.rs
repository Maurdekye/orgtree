//! Bounded image reads for Markdown. Requests are authorized by the regular
//! desktop-token middleware; URLs and local paths never enter request logs.

use std::io::Cursor;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use axum::extract::Query;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures::StreamExt;
use serde::Deserialize;

const MAX_BYTES: usize = 10 * 1024 * 1024;
const MAX_PIXELS: u64 = 16_000_000;
const MAX_DIMENSION: u32 = 8_192;
const MAX_REDIRECTS: usize = 5;

#[derive(Deserialize)]
pub struct ImageQuery {
    path: Option<String>,
    url: Option<String>,
}

pub async fn get(Query(query): Query<ImageQuery>) -> Response {
    let result = match (query.path, query.url) {
        (Some(path), None) => local_image(path).await,
        (None, Some(url)) => remote_image(url).await,
        _ => Err(StatusCode::BAD_REQUEST),
    };
    match result {
        Ok(bytes) => image_response(bytes),
        Err(status) => status.into_response(),
    }
}

async fn local_image(path: String) -> Result<Vec<u8>, StatusCode> {
    if path.len() > 32_768 {
        return Err(StatusCode::URI_TOO_LONG);
    }
    let path = local_image_path(&path)?;
    let metadata = local_image_metadata(&path).await?;
    if metadata.len() > MAX_BYTES as u64 {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let metadata = local_image_open_metadata(&file).await?;
    if metadata.len() > MAX_BYTES as u64 {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if bytes.len() > MAX_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    validate_image(&bytes)?;
    Ok(bytes)
}

fn local_image_path(raw: &str) -> Result<PathBuf, StatusCode> {
    let bytes = raw.as_bytes();
    if bytes.len() < 3
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || !matches!(bytes[2], b'\\' | b'/')
        || bytes[2..].contains(&b':')
        || raw[3..]
            .split(|character| character == '\\' || character == '/')
            .any(is_reserved_device_component)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(path)
}

fn is_reserved_device_component(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(|character| character == ' ' || character == '.');
    matches!(
        stem.to_ascii_uppercase().as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "CONIN$"
            | "CONOUT$"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
    )
}

/// Check each component before opening, without following a symlink or reparse
/// point. These lexical and component checks reject crafted paths; an attacker
/// who can mutate the local disk can still race a path change between checking
/// and opening it (documented limitation).
async fn local_image_metadata(path: &Path) -> Result<std::fs::Metadata, StatusCode> {
    let raw = path.to_str().ok_or(StatusCode::BAD_REQUEST)?;
    let mut current = PathBuf::from(&raw[..3]);
    let mut metadata = tokio::fs::symlink_metadata(&current)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if metadata_is_reparse_point(&metadata) || !metadata.is_dir() {
        return Err(StatusCode::BAD_REQUEST);
    }

    let components = path.components().skip(2).collect::<Vec<_>>();
    if components.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    for (index, component) in components.iter().enumerate() {
        current.push(component.as_os_str());
        metadata = tokio::fs::symlink_metadata(&current)
            .await
            .map_err(|_| StatusCode::NOT_FOUND)?;
        if metadata_is_reparse_point(&metadata) {
            return Err(StatusCode::BAD_REQUEST);
        }
        let final_component = index + 1 == components.len();
        if final_component {
            if !metadata.is_file() {
                return Err(StatusCode::BAD_REQUEST);
            }
        } else if !metadata.is_dir() {
            return Err(StatusCode::BAD_REQUEST);
        }
    }
    Ok(metadata)
}

fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

async fn local_image_open_metadata(
    file: &tokio::fs::File,
) -> Result<std::fs::Metadata, StatusCode> {
    let metadata = file.metadata().await.map_err(|_| StatusCode::NOT_FOUND)?;
    if !metadata.is_file() {
        return Err(StatusCode::BAD_REQUEST);
    }
    ensure_open_image_has_local_path(file)?;
    Ok(metadata)
}

#[cfg(windows)]
fn final_path_is_local_drive(raw: &str) -> bool {
    let raw = raw.strip_prefix(r"\\?\").unwrap_or(raw);
    local_image_path(raw).is_ok()
}

#[cfg(windows)]
fn ensure_open_image_has_local_path(file: &tokio::fs::File) -> Result<(), StatusCode> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileType, FILE_TYPE_DISK};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };

    let handle = file.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
    if unsafe { GetFileType(handle) } != FILE_TYPE_DISK {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut buffer = vec![0u16; 512];
    loop {
        let length = unsafe {
            GetFinalPathNameByHandleW(
                handle,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if length == 0 {
            return Err(StatusCode::BAD_REQUEST);
        }
        if length >= buffer.len() {
            if length >= 32_768 {
                return Err(StatusCode::URI_TOO_LONG);
            }
            buffer.resize(length + 1, 0);
            continue;
        }
        let final_path =
            String::from_utf16(&buffer[..length]).map_err(|_| StatusCode::BAD_REQUEST)?;
        return if final_path_is_local_drive(&final_path) {
            Ok(())
        } else {
            Err(StatusCode::BAD_REQUEST)
        };
    }
}

#[cfg(not(windows))]
fn ensure_open_image_has_local_path(_file: &tokio::fs::File) -> Result<(), StatusCode> {
    Err(StatusCode::BAD_REQUEST)
}

async fn remote_image(raw: String) -> Result<Vec<u8>, StatusCode> {
    if raw.len() > 4096 {
        return Err(StatusCode::URI_TOO_LONG);
    }
    let mut url = reqwest::Url::parse(&raw).map_err(|_| StatusCode::BAD_REQUEST)?;
    for redirects in 0..=MAX_REDIRECTS {
        validate_remote_url(&url)?;
        let client = pinned_client(&url).await?;
        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        if response.status().is_redirection() {
            if redirects == MAX_REDIRECTS {
                return Err(StatusCode::BAD_GATEWAY);
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .ok_or(StatusCode::BAD_GATEWAY)?;
            let location = location.to_str().map_err(|_| StatusCode::BAD_GATEWAY)?;
            url = url.join(location).map_err(|_| StatusCode::BAD_GATEWAY)?;
            continue;
        }
        if !response.status().is_success() {
            return Err(StatusCode::BAD_GATEWAY);
        }
        if response
            .content_length()
            .is_some_and(|len| len > MAX_BYTES as u64)
        {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| StatusCode::BAD_GATEWAY)?;
            if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
                return Err(StatusCode::PAYLOAD_TOO_LARGE);
            }
            bytes.extend_from_slice(&chunk);
        }
        validate_image(&bytes)?;
        return Ok(bytes);
    }
    Err(StatusCode::BAD_GATEWAY)
}

fn validate_remote_url(url: &reqwest::Url) -> Result<(), StatusCode> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(())
}

async fn pinned_client(url: &reqwest::Url) -> Result<reqwest::Client, StatusCode> {
    let host = url.host_str().ok_or(StatusCode::BAD_REQUEST)?;
    let port = url.port_or_known_default().ok_or(StatusCode::BAD_REQUEST)?;
    let address = if let Ok(ip) = host.parse::<IpAddr>() {
        if !is_public_ip(ip) {
            return Err(StatusCode::FORBIDDEN);
        }
        SocketAddr::new(ip, port)
    } else {
        let mut addresses = tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| StatusCode::BAD_GATEWAY)?;
        addresses
            .find(|addr| is_public_ip(addr.ip()))
            .ok_or(StatusCode::FORBIDDEN)?
    };
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(12))
        .no_proxy();
    if host.parse::<IpAddr>().is_err() {
        builder = builder.resolve(host, address);
    }
    builder.build().map_err(|_| StatusCode::BAD_GATEWAY)
}

fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => is_public_v6(ip),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || a == 0
        || a >= 224
        || (a == 100 && (64..=127).contains(&b)) // shared address space
        || (a == 192 && b == 0 && c == 0) // protocol assignments
        || (a == 192 && b == 0 && c == 2) // documentation
        || (a == 192 && b == 88 && c == 99) // deprecated 6to4 relay
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || (a == 198 && b == 51 && c == 100) // documentation
        || (a == 203 && b == 0 && c == 113)) // documentation
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    // Allow only global unicast 2000::/3, excluding documentation and
    // IPv4-mapped addresses (which otherwise disguise private IPv4 ranges).
    (s[0] & 0xe000) == 0x2000
        && !(s[0] == 0x2001 && (s[1] <= 0x01ff || s[1] == 0x0db8))
        && !(s[0] == 0x2002) // 6to4 is deprecated and can tunnel private IPv4
        && !(s[0] == 0x3fff && (s[1] & 0xf000) == 0) // documentation
        && ip.to_ipv4_mapped().is_none()
}

fn validate_image(bytes: &[u8]) -> Result<&'static str, StatusCode> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        if bytes.len() < 14 || bytes.last() != Some(&0x3b) {
            return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE);
        }
        let width = u16::from_le_bytes([bytes[6], bytes[7]]);
        let height = u16::from_le_bytes([bytes[8], bytes[9]]);
        if width == 0
            || height == 0
            || u32::from(width) > MAX_DIMENSION
            || u32::from(height) > MAX_DIMENSION
            || u64::from(width) * u64::from(height) > MAX_PIXELS
        {
            return Err(StatusCode::UNPROCESSABLE_ENTITY);
        }
        return Ok("image/gif");
    }
    let format = image::guess_format(bytes).map_err(|_| StatusCode::UNSUPPORTED_MEDIA_TYPE)?;
    let content_type = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::WebP => "image/webp",
        _ => return Err(StatusCode::UNSUPPORTED_MEDIA_TYPE),
    };
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| StatusCode::UNSUPPORTED_MEDIA_TYPE)?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|_| StatusCode::UNSUPPORTED_MEDIA_TYPE)?;
    if width == 0
        || height == 0
        || width > MAX_DIMENSION
        || height > MAX_DIMENSION
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(StatusCode::UNPROCESSABLE_ENTITY);
    }
    Ok(content_type)
}

fn image_response(bytes: Vec<u8>) -> Response {
    let content_type = match validate_image(&bytes) {
        Ok(mime) => mime,
        Err(status) => return status.into_response(),
    };
    let mut response = bytes.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG_1X1: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, b'I', b'H', b'D',
        b'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0b, b'I', b'D', b'A', b'T', 0x78, 0x9c, 0x63, 0x60,
        0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x01, 0xa5, 0xf6, 0x45, 0x40, 0x00, 0x00, 0x00, 0x00,
        b'I', b'E', b'N', b'D', 0xae, 0x42, 0x60, 0x82,
    ];
    const GIF_1X1: &[u8] = b"GIF89a\x01\x00\x01\x00\xf0\x00\x00\x00\x00\x00\xff\xff\xff\x21\xf9\x04\x01\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b";

    #[test]
    fn only_supported_raster_images_with_bounded_dimensions_are_accepted() {
        assert_eq!(validate_image(PNG_1X1), Ok("image/png"));
        assert_eq!(validate_image(GIF_1X1), Ok("image/gif"));
        assert_eq!(
            validate_image(b"<svg xmlns='http://www.w3.org/2000/svg'/>").unwrap_err(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(
            validate_image(b"not an image").unwrap_err(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
    }

    #[test]
    fn raster_dimensions_are_bounded_per_axis_and_by_total_pixels() {
        let mut too_wide = GIF_1X1.to_vec();
        too_wide[6..8].copy_from_slice(&((MAX_DIMENSION + 1) as u16).to_le_bytes());
        assert_eq!(
            validate_image(&too_wide),
            Err(StatusCode::UNPROCESSABLE_ENTITY)
        );

        let mut too_many_pixels = GIF_1X1.to_vec();
        too_many_pixels[6..8].copy_from_slice(&4_001u16.to_le_bytes());
        too_many_pixels[8..10].copy_from_slice(&4_000u16.to_le_bytes());
        assert_eq!(
            validate_image(&too_many_pixels),
            Err(StatusCode::UNPROCESSABLE_ENTITY)
        );
    }

    #[test]
    fn remote_urls_reject_non_http_schemes_and_embedded_credentials() {
        assert!(
            validate_remote_url(&reqwest::Url::parse("https://images.example/a.png").unwrap())
                .is_ok()
        );
        assert_eq!(
            validate_remote_url(&reqwest::Url::parse("file:///C:/secret.png").unwrap())
                .unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            validate_remote_url(
                &reqwest::Url::parse("https://user:pass@images.example/a.png").unwrap()
            )
            .unwrap_err(),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn remote_dns_pinning_only_accepts_public_addresses() {
        assert!(is_public_ip("8.8.8.8".parse().unwrap()));
        assert!(!is_public_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("10.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("169.254.169.254".parse().unwrap()));
        assert!(!is_public_ip("::1".parse().unwrap()));
        assert!(!is_public_ip("fd00::1".parse().unwrap()));
    }

    #[cfg(windows)]
    #[test]
    fn local_image_path_accepts_only_absolute_drive_paths() {
        for path in [r"C:\images\chart.png", "D:/images/chart.png"] {
            assert!(
                local_image_path(path).is_ok(),
                "drive path should pass: {path}"
            );
        }

        for path in [
            r"\\server\share\chart.png",
            "//server/share/chart.png",
            r"\\?\C:\images\chart.png",
            r"\\?\UNC\server\share\chart.png",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1\chart.png",
            r"\\.\C:\images\chart.png",
            r"\\.\pipe\orgtree-image",
            r"\\.\PhysicalDrive0",
            r"\??\C:\images\chart.png",
            r"\Device\HarddiskVolume1\chart.png",
            r"C:\images\chart.png:stream",
            r"C:\NUL",
            r"C:\images\CON.txt",
            r"C:\images\COM1.png",
            r"C:images\chart.png",
            r"\images\chart.png",
            "/images/chart.png",
            "relative/chart.png",
            "",
        ] {
            assert_eq!(
                local_image_path(path).unwrap_err(),
                StatusCode::BAD_REQUEST,
                "non-drive path must be rejected without opening it: {path}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn final_handle_paths_accept_only_drive_letter_paths() {
        assert!(final_path_is_local_drive(r"\\?\C:\images\chart.png"));
        assert!(final_path_is_local_drive(r"D:\images\chart.png"));
        assert!(!final_path_is_local_drive(
            r"\\?\UNC\server\share\chart.png"
        ));
        assert!(!final_path_is_local_drive(r"\\?\Volume{abc}\chart.png"));
        assert!(!final_path_is_local_drive(r"\\.\pipe\orgtree-image"));
        assert!(!final_path_is_local_drive(
            r"\\?\C:\images\chart.png:stream"
        ));
    }

    #[cfg(windows)]
    struct ScratchDir(PathBuf);

    #[cfg(windows)]
    impl ScratchDir {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "orgtree-markdown-image-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).expect("create local image test scratch directory");
            Self(path)
        }
    }

    #[cfg(windows)]
    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(windows)]
    fn create_local_junction(link: &Path, target: &Path) {
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .expect("create local test junction");
        assert!(
            output.status.success(),
            "mklink /J failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn local_image_file_checks_reject_junctions_and_non_files() {
        use std::os::windows::fs::OpenOptionsExt;

        let scratch = ScratchDir::new();
        let target_dir = scratch.0.join("target");
        std::fs::create_dir(&target_dir).unwrap();
        let image = target_dir.join("chart.png");
        std::fs::write(&image, PNG_1X1).unwrap();

        let parent_junction = scratch.0.join("parent-junction");
        create_local_junction(&parent_junction, &target_dir);
        assert_eq!(
            local_image_metadata(&parent_junction.join("chart.png"))
                .await
                .unwrap_err(),
            StatusCode::BAD_REQUEST,
            "a junction in a parent component is rejected before opening"
        );

        let leaf_junction = scratch.0.join("leaf-junction");
        create_local_junction(&leaf_junction, &target_dir);
        assert_eq!(
            local_image_metadata(&leaf_junction).await.unwrap_err(),
            StatusCode::BAD_REQUEST,
            "a junction used as the leaf is rejected before opening"
        );
        assert_eq!(
            local_image_metadata(&target_dir).await.unwrap_err(),
            StatusCode::BAD_REQUEST,
            "a directory is not a regular image file"
        );
        let directory_handle = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
            .open(&target_dir)
            .unwrap();
        let directory_file = tokio::fs::File::from_std(directory_handle);
        assert_eq!(
            local_image_open_metadata(&directory_file)
                .await
                .unwrap_err(),
            StatusCode::BAD_REQUEST,
            "an opened directory handle is rejected before reading"
        );

        let metadata = local_image_metadata(&image).await.unwrap();
        assert!(metadata.is_file());
        let file = tokio::fs::File::open(&image).await.unwrap();
        assert!(local_image_open_metadata(&file).await.unwrap().is_file());
    }
}

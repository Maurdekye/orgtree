//! Mail-hub request transport shared with the read-only health Test.
use super::*;

#[nolog]
pub(crate) async fn send(request:reqwest::RequestBuilder)->reqwest::Result<reqwest::Response> {
    request.send().await
}

/// Streaming upload bodies must be opened separately for each attempt.
#[nolog]
pub(super) async fn stream<F,Fut>(mut build:F)->Result<reqwest::Response>
where F:FnMut(reqwest::Client)->Fut,
      Fut:std::future::Future<Output=Result<reqwest::RequestBuilder>> {
    Ok(build(HTTP.clone()).await?.send().await?)
}

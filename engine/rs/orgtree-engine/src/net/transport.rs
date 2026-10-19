//! Mail-hub request transport shared with the read-only health Test.
use super::*;

// The initial connection must fail before short (two-second) health/typing
// request deadlines expire. A total request timeout cannot safely be replayed:
// it may occur after the server accepted a write.
pub(super) const DIRECT_CONNECT_TIMEOUT:Duration=Duration::from_secs(1);

static PROXY:LazyLock<reqwest::Client>=LazyLock::new(||reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(5))
    .user_agent(concat!("orgtree-engine/",env!("CARGO_PKG_VERSION")))
    .build().expect("mail hub proxy client"));

#[nolog]
pub(super) async fn healthz(address:&str,timeout:Duration)->Option<Value> {
    let response=send(HTTP.get(format!("{address}/healthz")).timeout(timeout)).await.ok()?;
    if !response.status().is_success(){return None;}
    response.json::<Value>().await.ok().filter(Value::is_object)
}

#[nolog]
fn retryable(error:&reqwest::Error,url:&reqwest::Url)->bool {
    // A response, body/read failure or an error after following a redirect
    // may follow an accepted write. Only replay a failed initial connect.
    error.is_connect()&&error.url()==Some(url)
}

#[nolog]
pub(crate) async fn send(request:reqwest::RequestBuilder)->reqwest::Result<reqwest::Response> {
    send_with_proxy(request,&PROXY).await
}

/// A caller with stricter redirect policy supplies its matching proxy client.
#[nolog]
pub(super) async fn send_with_proxy(request:reqwest::RequestBuilder,proxy:&reqwest::Client)->reqwest::Result<reqwest::Response> {
    let (client,request)=request.build_split();let request=request?;
    let url=request.url().clone();let replay=request.try_clone();
    match client.execute(request).await {
        Err(error) if retryable(&error,&url)&&replay.is_some()=>proxy.execute(replay.unwrap()).await,
        result=>result,
    }
}

/// Streaming upload bodies must be opened separately for each attempt.
#[nolog]
pub(super) async fn stream<F,Fut>(mut build:F)->Result<reqwest::Response>
where F:FnMut(reqwest::Client)->Fut,
      Fut:std::future::Future<Output=Result<reqwest::RequestBuilder>> {
    let request=build(HTTP.clone()).await?.build()?;
    let url=request.url().clone();
    match HTTP.execute(request).await {
        Err(error) if retryable(&error,&url)=>Ok(build(PROXY.clone()).await?.send().await?),
        result=>Ok(result?),
    }
}

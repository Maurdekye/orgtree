use super::*;
use tokio::io::{AsyncReadExt,AsyncWriteExt};

async fn fixture(body:&str,requests:usize)->(String,tokio::task::JoinHandle<()>) {
    fixture_status(body,requests,"200 OK").await
}

async fn fixture_status(body:&str,requests:usize,status:&str)->(String,tokio::task::JoinHandle<()>) {
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address=format!("http://{}",listener.local_addr().unwrap());
    let body=body.to_owned();let status=status.to_owned();
    let task=tokio::spawn(async move {
        for _ in 0..requests {
            let(mut socket,_)=listener.accept().await.unwrap();
            let mut request=[0;4096];let _=socket.read(&mut request).await.unwrap();
            let response=format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
            socket.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (address,task)
}

#[test]
fn bare_host_candidates_match_hubchat_without_guessing_explicit_urls() {
    assert_eq!(discovery::candidates("example.invalid"),vec!["http://example.invalid:7370","http://example.invalid:7378","http://example.invalid:7371","https://example.invalid"]);
    assert_eq!(discovery::candidates("https://example.invalid"),vec!["https://example.invalid"]);
    assert_eq!(discovery::candidates("example.invalid:7378"),vec!["http://example.invalid:7378"]);
    assert_eq!(discovery::candidates(""),vec![DEFAULT_HUB_ADDRESS]);
}

#[tokio::test]
async fn explicit_local_hub_control_still_answers() {
    let(address,server)=fixture("{\"ok\":true,\"name\":\"control\"}",1).await;
    let addresses=discovery::candidates(&address);
    assert_eq!(addresses,vec![address.clone()]);
    let found=discovery::probe_many(addresses,Duration::from_secs(2)).await.unwrap();
    assert_eq!(found.0,address);assert_eq!(found.1["name"],"control");
    server.await.unwrap();
}

#[test]
fn explicit_standard_ports_and_ipv6_are_not_rewritten_to_7370() {
    assert_eq!(normalize_address("example.invalid:80"),"http://example.invalid:80");
    assert_eq!(normalize_address("http://[::1]:80"),"http://[::1]:80");
    assert_eq!(normalize_address("[::1]:7378"),"http://[::1]:7378");
}

#[test]
fn registered_endpoint_is_reused_only_within_the_current_candidate_set() {
    assert_eq!(discovery::known_address("office.invalid",Some("http://office.invalid:7378")),"http://office.invalid:7378");
    assert_eq!(discovery::known_address("other.invalid",Some("http://office.invalid:7378")),"http://other.invalid:7370");
    assert_eq!(discovery::known_address("office.invalid:7371",Some("http://office.invalid:7378")),"http://office.invalid:7371");
    assert_eq!(discovery::candidates("[::1]")[1],"http://[::1]:7378");
    assert_eq!(discovery::candidates("office.invalid:80"),vec!["http://office.invalid:80"]);
}

#[tokio::test]
async fn candidates_start_concurrently_before_any_candidate_can_answer() {
    let barrier=Arc::new(tokio::sync::Barrier::new(3));
    let mut servers=tokio::task::JoinSet::new();let mut addresses=Vec::new();
    for _ in 0..2 {
        let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        addresses.push(format!("http://{}",listener.local_addr().unwrap()));
        let barrier=barrier.clone();
        servers.spawn(async move {
            let(mut socket,_)=listener.accept().await.unwrap();
            let mut request=[0;4096];let _=socket.read(&mut request).await.unwrap();
            barrier.wait().await;
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").await.unwrap();
        });
    }
    let mut probe=tokio::spawn(discovery::probe_many(addresses,Duration::from_secs(5)));
    let concurrent=tokio::time::timeout(Duration::from_secs(2),barrier.wait()).await.is_ok();
    if !concurrent {probe.abort();servers.abort_all();}
    assert!(concurrent,"all candidate requests must arrive before any server is allowed to answer");
    assert!(tokio::time::timeout(Duration::from_secs(3),&mut probe).await.unwrap().unwrap().is_some());
    while let Some(result)=servers.join_next().await {result.unwrap();}
}

#[tokio::test]
async fn arbitrary_json_is_not_a_successful_mail_hub_test() {
    let(address,server)=fixture("{\"message\":\"not a mail hub\"}",1).await;
    let found=discovery::probe_many(vec![address],Duration::from_secs(2)).await;
    server.await.unwrap();assert!(found.is_none());
}

#[tokio::test]
async fn real_mail_client_matches_direct_test_with_a_broken_system_proxy() {
    const CHILD:&str="ORGTREE_HUB_PROXY_TEST_CHILD";
    if std::env::var(CHILD).as_deref()!=Ok("1") {
        let output=std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact","net::discovery_tests::real_mail_client_matches_direct_test_with_a_broken_system_proxy","--nocapture"])
            .env(CHILD,"1").env("HTTP_PROXY","http://127.0.0.1:1").env("HTTPS_PROXY","http://127.0.0.1:1")
            .env("ALL_PROXY","http://127.0.0.1:1").env("NO_PROXY","").output().unwrap();
        assert!(output.status.success(),"isolated proxy control failed: {}{}",String::from_utf8_lossy(&output.stdout),String::from_utf8_lossy(&output.stderr));
        return;
    }
    let(address,server)=fixture("{\"ok\":true}",2).await;
    assert!(crate::mailhub::healthz(&address,Duration::from_secs(2)).await.is_some(),"the existing direct test must answer first");
    let real=transport::send(HTTP.get(format!("{address}/healthz")).timeout(Duration::from_secs(2))).await;
    assert!(real.is_ok_and(|r|r.status().is_success()),"real mail requests must use the same direct transport as the successful test");
    server.await.unwrap();
}

#[tokio::test]
async fn proxy_required_test_and_real_mail_preserve_432_connectivity() {
    const CHILD:&str="ORGTREE_HUB_REQUIRED_PROXY_CHILD";
    if std::env::var(CHILD).as_deref()!=Ok("1") {
        let listener=std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let proxy=format!("http://{}",listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let listener=tokio::net::TcpListener::from_std(listener).unwrap();
        let server=tokio::spawn(async move {
            for _ in 0..3 {
                let (mut socket,_)=listener.accept().await.unwrap();
                let mut request=[0;4096];let n=socket.read(&mut request).await.unwrap();
                let request=String::from_utf8_lossy(&request[..n]);
                assert!(request.contains("http://127.0.0.1:1/"),"proxy must receive the originally configured endpoint");
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").await.unwrap();
            }
        });
        let output=tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact","net::discovery_tests::proxy_required_test_and_real_mail_preserve_432_connectivity","--nocapture"])
            .env(CHILD,"1").env("HTTP_PROXY",&proxy).env("HTTPS_PROXY",&proxy).env("ALL_PROXY",&proxy).env("NO_PROXY","")
            .output().await.unwrap();
        if !output.status.success(){server.abort();}
        assert!(output.status.success(),"proxy-required child failed: {}{}",String::from_utf8_lossy(&output.stdout),String::from_utf8_lossy(&output.stderr));
        tokio::time::timeout(Duration::from_secs(3),server).await.unwrap().unwrap();
        return;
    }
    // Closed loopback port is deliberately unreachable directly; only the
    // local proxy can answer. No corporate endpoint or external DNS is used.
    let address="http://127.0.0.1:1";
    let health=crate::mailhub::healthz(address,Duration::from_secs(2)).await;
    assert!(health.is_some_and(|h|h["ok"]==true),"Test must fall back to the configured proxy on connect failure");
    let real=transport::send(HTTP.post(format!("{address}/api/register")).timeout(Duration::from_secs(2)).json(&json!({"synthetic":true}))).await.unwrap();
    assert!(real.status().is_success());
    let builds=Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count=builds.clone();
    let response=transport::stream(|http| {
        let count=count.clone();
        async move {
            count.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
            let bytes=futures::stream::once(async {Ok::<_,std::io::Error>(vec![1u8,2,3])});
            Ok(http.post(format!("{address}/api/attachments")).timeout(Duration::from_secs(2)).body(reqwest::Body::wrap_stream(bytes)))
        }
    }).await.unwrap();
    assert!(response.status().is_success());
    assert_eq!(builds.load(std::sync::atomic::Ordering::SeqCst),2,"streaming body must be recreated only after failed direct connect");
}

#[tokio::test]
async fn an_http_response_never_replays_a_mail_write() {
    let(address,server)=fixture_status("{\"error\":\"denied\"}",1,"403 Forbidden").await;
    let builds=Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count=builds.clone();
    let response=transport::stream(|http| {
        let address=address.clone();let count=count.clone();
        async move {count.fetch_add(1,std::sync::atomic::Ordering::SeqCst);Ok(http.post(address).body("synthetic"))}
    }).await.unwrap();
    assert_eq!(response.status().as_u16(),403);
    assert_eq!(builds.load(std::sync::atomic::Ordering::SeqCst),1);
    server.await.unwrap();
}

#[test]
fn adding_a_hub_assigns_a_stable_registration_key_and_repairs_old_entries() {
    // The actual AddHub payload deliberately has no caller-generated id.
    let mut hubs=json!([
        {"address":"http://office.invalid:7378","enabled":true},
        {"id":"kept","address":"http://other.invalid:7378","enabled":false},
        {"id":"","address":"http://third.invalid:7378","enabled":true},
        {"id":"kept","address":"http://fourth.invalid:7378","enabled":true}
    ]);
    assert!(assign_hub_ids(&mut hubs),"new and already persisted keyless hubs must become registration participants");
    let ids:Vec<_>=hubs.as_array().unwrap().iter().map(|h|h["id"].as_str().filter(|id|!id.is_empty()).expect("registration worker requires a nonempty string id")).collect();
    assert_eq!(ids[1],"kept","existing valid key must preserve registrations and status");
    assert_eq!(ids.iter().copied().collect::<HashSet<_>>().len(),4);
    assert_eq!(hubs[0]["address"],"http://office.invalid:7378");
    assert_eq!(hubs[1]["enabled"],false);
    let saved=hubs.clone();
    assert!(!assign_hub_ids(&mut hubs));
    assert_eq!(hubs,saved,"repeated passes must never churn valid connection keys");
}

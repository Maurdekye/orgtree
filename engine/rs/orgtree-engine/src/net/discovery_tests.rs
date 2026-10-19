use super::*;
use tokio::io::{AsyncReadExt,AsyncWriteExt};

async fn fixture(body:&str,requests:usize)->(String,tokio::task::JoinHandle<()>) {
    let listener=tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address=format!("http://{}",listener.local_addr().unwrap());
    let body=body.to_owned();
    let task=tokio::spawn(async move {
        for _ in 0..requests {
            let(mut socket,_)=listener.accept().await.unwrap();
            let mut request=[0;4096];let _=socket.read(&mut request).await.unwrap();
            let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body);
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
    assert_eq!(normalize_address("example.invalid:80"),"http://example.invalid");
    assert_eq!(normalize_address("http://[::1]:80"),"http://[::1]");
    assert_eq!(normalize_address("[::1]:7378"),"http://[::1]:7378");
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
    let real=HTTP.get(format!("{address}/healthz")).timeout(Duration::from_secs(2)).send().await;
    assert!(real.is_ok_and(|r|r.status().is_success()),"real mail requests must use the same direct transport as the successful test");
    server.await.unwrap();
}

//! Scripted ACP peer. No provider network calls. Per-seat acp-fixture.json
//! selects a bounded delay and permission requests; session data lives in the
//! launcher's XDG data root so a fresh process must really load the old session.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, mpsc, atomic::{AtomicBool, AtomicU64, Ordering}};
use std::time::Duration;
use serde_json::{json, Value};

struct Peer {
    out: Mutex<std::io::Stdout>,
    waiters: Mutex<HashMap<String,mpsc::Sender<Value>>>,
    next: AtomicU64,
    cancelled: AtomicBool,
}
impl Peer {
    fn send(&self, value: Value) {
        let mut out=self.out.lock().unwrap();
        let _=writeln!(out,"{value}"); let _=out.flush();
    }
    fn result(&self,id:&Value,result:Value) { self.send(json!({"jsonrpc":"2.0","id":id,"result":result})); }
    fn update(&self,sid:&str,update:Value) { self.send(json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":sid,"update":update}})); }
    fn permission(&self,sid:&str,tool:Value)->Value {
        let id=format!("permission-{}",self.next.fetch_add(1,Ordering::SeqCst));
        let (tx,rx)=mpsc::channel(); self.waiters.lock().unwrap().insert(id.clone(),tx);
        self.send(json!({"jsonrpc":"2.0","id":id,"method":"session/request_permission","params":{
            "sessionId":sid,"toolCall":tool,"options":[
                {"kind":"allow_always","optionId":"always"},
                {"kind":"allow_once","optionId":"once"},
                {"kind":"reject_once","optionId":"reject"}]}}));
        let answer=rx.recv_timeout(Duration::from_secs(5)).unwrap_or(Value::Null);
        self.waiters.lock().unwrap().remove(&id); answer
    }
}

struct Bridge { child:Child, input:Option<ChildStdin>, output:BufReader<ChildStdout> }
impl Bridge {
    fn start(config:&Value)->Option<Self> {
        let command=config.pointer("/mcp/servers/orgtree/command")?.as_array()?;
        let mut cmd=Command::new(command.first()?.as_str()?);
        for arg in command.iter().skip(1) {cmd.arg(arg.as_str()?);}
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x08000000); }
        let mut child=cmd.spawn().ok()?;
        let input=child.stdin.take(); let output=BufReader::new(child.stdout.take()?);
        let mut bridge=Self{child,input,output};
        bridge.call(1,"initialize",json!({"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"ACP rig","version":"1"}}))?;
        bridge.call(2,"tools/list",json!({}))?;
        Some(bridge)
    }
    fn call(&mut self,id:u64,method:&str,params:Value)->Option<Value> {
        let input=self.input.as_mut()?;
        writeln!(input,"{}",json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).ok()?; input.flush().ok()?;
        let mut line=String::new(); self.output.read_line(&mut line).ok()?;
        serde_json::from_str(&line).ok()
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.input.take();
        for _ in 0..100 {if !matches!(self.child.try_wait(),Ok(None)){return;} std::thread::sleep(Duration::from_millis(10));}
        let _=self.child.kill();let _=self.child.wait();
    }
}

pub fn run()->i32 {
    let peer=Arc::new(Peer{out:Mutex::new(std::io::stdout()),waiters:Mutex::new(HashMap::new()),next:AtomicU64::new(1),cancelled:AtomicBool::new(false)});
    let config:Value=std::env::var("OPENCODE_CONFIG_CONTENT").ok().and_then(|s|serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
    let data=PathBuf::from(std::env::var("XDG_DATA_HOME").unwrap_or_default());
    let mut session=String::new();
    let mut bridge:Option<Arc<Mutex<Bridge>>>=None;
    for line in std::io::stdin().lock().lines() {
        let Ok(line)=line else{break}; let Ok(v)=serde_json::from_str::<Value>(&line) else{continue};
        let id=&v["id"]; let params=&v["params"];
        match v["method"].as_str() {
            Some("initialize")=>peer.result(id,json!({"protocolVersion":1,"agentInfo":{"name":"OpenCode","version":"2.0.28"},"agentCapabilities":{"loadSession":true}})),
            Some("session/new")|Some("session/load")=>{
                let load=v["method"]=="session/load";
                session=if load {params["sessionId"].as_str().unwrap_or("").into()} else{format!("rig-acp-{}-{}",std::process::id(),super::now_ms())};
                let record=data.join(format!("{session}.json"));
                if load && !record.is_file() {peer.send(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32001,"message":"missing session"}}));continue;}
                let _=std::fs::create_dir_all(&data);
                if !load {let _=std::fs::write(record,b"{}");}
                bridge=Bridge::start(&config).map(|b|Arc::new(Mutex::new(b)));
                if load {peer.update(&session,json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"REPLAY_MUST_NOT_APPEAR"}}));}
                peer.result(id,json!({"sessionId":session}));
            },
            Some("session/set_config_option")=>peer.result(id,json!({"configOptions":[]})),
            Some("session/cancel")=>{peer.cancelled.store(true,Ordering::SeqCst);},
            Some("session/prompt")=>{
                peer.cancelled.store(false,Ordering::SeqCst);
                // Secret-free start receipt lets the rig distinguish a new
                // process from warm reuse and next-turn mail from injection.
                let prompt=params["prompt"].as_array().into_iter().flatten().filter_map(|v|v["text"].as_str()).collect::<Vec<_>>().join("\n");
                let observed=json!({"pid":std::process::id(),"session":session,
                    "input_text_bytes":prompt.len(),"mail_reference":prompt.contains("MAIL BY REFERENCE"),
                    "home":std::env::var("HOME").unwrap_or_default(),
                    "model":config["model"],
                    "skills":config["skills"],
                    "skillPermissions":config["permissions"].as_array().into_iter().flatten()
                        .filter(|r| r["action"] == "skill").cloned().collect::<Vec<_>>(),
                    "queuedMarker":params.to_string().contains("ACP_QUEUED_MARKER")});
                if let Ok(mut file)=std::fs::OpenOptions::new().create(true).append(true).open("acp-observed.jsonl") {
                    let _=writeln!(file,"{observed}");
                }
                let p=peer.clone();let sid=session.clone();let id=id.clone();let bridge=bridge.clone();
                let fixture=super::load_json(&PathBuf::from("acp-fixture.json")).unwrap_or(json!({}));
                std::thread::spawn(move||{
                    let delay=fixture["delayMs"].as_u64().unwrap_or(0).min(30_000);
                    for _ in 0..delay.div_ceil(10) {if p.cancelled.load(Ordering::SeqCst){break;}std::thread::sleep(Duration::from_millis(10));}
                    if p.cancelled.load(Ordering::SeqCst){p.result(&id,json!({"stopReason":"cancelled"}));return;}
                    p.update(&sid,json!({"sessionUpdate":"agent_thought_chunk","messageId":"thought","content":{"type":"text","text":"ACP fixture reasoning"}}));
                    let mut decisions=Vec::new();
                    for tool in fixture["permissions"].as_array().into_iter().flatten() {decisions.push(p.permission(&sid,tool.clone()));}
                    let mcp=bridge.as_ref().and_then(|b|b.lock().ok()?.call(3,"tools/call",json!({"name":"orgtree_status","arguments":{"status":"working","summary":"ACP fixture bridge"}})));
                    p.update(&sid,json!({"sessionUpdate":"tool_call","toolCallId":"status","name":"orgtree_orgtree_status","status":"in_progress","rawInput":{"status":"working"}}));
                    p.update(&sid,json!({"sessionUpdate":"tool_call_update","toolCallId":"status","status":"completed","content":[{"type":"content","content":{"type":"text","text":mcp.as_ref().map(Value::to_string).unwrap_or_else(||"MCP absent".into())}}]}));
                    let text=format!("ACP_FIXTURE {} decisions={}",fixture["text"].as_str().unwrap_or("OK"),Value::Array(decisions));
                    p.update(&sid,json!({"sessionUpdate":"agent_message_chunk","messageId":"answer","content":{"type":"text","text":text}}));
                    p.update(&sid,json!({"sessionUpdate":"usage_update","used":300,"size":8192,"cost":{"amount":0,"currency":"USD"}}));
                    p.result(&id,json!({"stopReason":"end_turn","usage":{"inputTokens":12,"outputTokens":7,"cachedReadTokens":3}}));
                });
            },
            None=>{if let Some(id)=id.as_str(){if let Some(tx)=peer.waiters.lock().unwrap().remove(id){let _=tx.send(v);}}},
            _=>peer.send(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"unsupported fixture method"}})),
        }
    }
    peer.cancelled.store(true,Ordering::SeqCst);0
}

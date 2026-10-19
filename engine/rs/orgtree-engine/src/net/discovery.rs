//! Hub discovery extracted without changing the current single-address policy.
use super::*;

#[nolog]
pub(super) fn candidates(input:&str)->Vec<String> {
    vec![if input.trim().is_empty(){DEFAULT_HUB_ADDRESS.to_owned()}else{normalize_address(input)}]
}

#[nolog]
pub(super) async fn probe_many(addresses:Vec<String>,limit:Duration)->Option<(String,Value)> {
    for address in addresses {
        if let Some(health)=crate::mailhub::healthz(&address,limit).await {
            return Some((address,health));
        }
    }
    None
}

//! A remote engine's address and the rule for sending its token there
//! (docs/rust-engine/remote-org.md, "Address"): `https` anywhere; plain `http`
//! only when every address the host resolves to is this computer, a private
//! network or Tailscale. The rule is asked again at every connect, and the
//! addresses it passed are the only ones the connection may dial.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use super::text;

/// `scheme://host[:port][/prefix]`, normalized. No user-info, query or fragment.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Address {
    pub tls: bool,
    /// Lower case; an IPv6 literal without its brackets.
    pub host: String,
    pub port: u16,
    /// Empty, or a path that starts with `/` and does not end with one.
    pub prefix: String,
}

#[logged]
impl Address {
    /// The address as typed. A missing scheme means `http://` (the rule below
    /// then decides whether plain http may be used at all).
    pub fn parse(raw: &str) -> Result<Address, &'static str> {
        let _ = raw;
        Err(text::E1)
    }

    /// `host[:port]`, an IPv6 literal in brackets, the scheme's own port left out.
    #[nolog]
    pub fn authority(&self) -> String {
        let host = if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.clone() };
        if self.port == if self.tls { 443 } else { 80 } { host } else { format!("{host}:{}", self.port) }
    }

    /// The base every request path is appended to.
    #[nolog]
    pub fn base(&self) -> String {
        format!("{}://{}{}", if self.tls { "https" } else { "http" }, self.authority(), self.prefix)
    }

    /// The same base for a socket.
    #[nolog]
    pub fn ws_base(&self) -> String {
        format!("{}://{}{}", if self.tls { "wss" } else { "ws" }, self.authority(), self.prefix)
    }
}

/// How the bytes travel, as Connection details names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    Https,
    Tailscale,
    PrivateHttp,
    Loopback,
}

#[logged]
impl Transport {
    #[nolog]
    pub fn as_str(self) -> &'static str {
        match self {
            Transport::Https => "https",
            Transport::Tailscale => "tailscale",
            Transport::PrivateHttp => "private-http",
            Transport::Loopback => "loopback",
        }
    }
}

/// Where one address is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Net {
    Loopback,
    /// 100.64.0.0/10 (CGNAT, which Tailscale uses) and Tailscale's IPv6 range.
    Tailscale,
    /// 10/8, 172.16/12, 192.168/16 and IPv6 unique local (fc00::/7).
    Private,
    Public,
}

// The private-sites work adds `domain::apps::net::classify` with the same
// private ranges (and no loopback); once it is on the line this reads it
// instead of naming the ranges a second time.
#[nolog]
pub fn classify(ip: IpAddr) -> Net {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return classify_v4(v4);
            }
            let s = v6.segments();
            if v6.is_loopback() {
                Net::Loopback
            } else if s[0] == 0xfd7a && s[1] == 0x115c && s[2] == 0xa1e0 {
                Net::Tailscale
            } else if (s[0] & 0xfe00) == 0xfc00 {
                Net::Private
            } else {
                Net::Public
            }
        }
    }
}

#[nolog]
fn classify_v4(ip: Ipv4Addr) -> Net {
    let o = ip.octets();
    if ip.is_loopback() {
        Net::Loopback
    } else if o[0] == 100 && (o[1] & 0xc0) == 64 {
        Net::Tailscale
    } else if ip.is_private() {
        Net::Private
    } else {
        Net::Public
    }
}

/// May the token be sent to a host with these addresses, and how does it
/// travel? `https` always may. Plain http needs every address to be this
/// computer, private or Tailscale: one public answer refuses it (E2).
#[logged]
pub fn vet(tls: bool, addrs: &[IpAddr]) -> Result<Transport, &'static str> {
    let _ = (tls, addrs);
    Err(text::E2)
}

/// Every address the host answers to right now (an IP literal is itself).
#[logged]
pub async fn resolve(address: &Address) -> Result<Vec<SocketAddr>, String> {
    if let Ok(ip) = address.host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, address.port)]);
    }
    let found = tokio::time::timeout(std::time::Duration::from_secs(10), tokio::net::lookup_host((address.host.as_str(), address.port)))
        .await
        .map_err(|_| "the name did not resolve in time".to_string())?
        .map_err(|e| format!("the name did not resolve: {e}"))?;
    let addrs: Vec<SocketAddr> = found.collect();
    if addrs.is_empty() {
        return Err("the name resolved to no address".into());
    }
    Ok(addrs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn https_goes_anywhere_and_plain_http_only_to_this_computer_private_networks_and_tailscale() {
        // https: any address, also a public one
        assert_eq!(vet(true, &[ip("203.0.113.9")]), Ok(Transport::Https));
        assert_eq!(vet(true, &[]), Ok(Transport::Https));
        // plain http: the allowed kinds, each named for what it is
        assert_eq!(vet(false, &[ip("127.0.0.1")]), Ok(Transport::Loopback));
        assert_eq!(vet(false, &[ip("::1")]), Ok(Transport::Loopback));
        assert_eq!(vet(false, &[ip("10.1.2.3")]), Ok(Transport::PrivateHttp));
        assert_eq!(vet(false, &[ip("172.16.0.1")]), Ok(Transport::PrivateHttp));
        assert_eq!(vet(false, &[ip("192.168.1.20")]), Ok(Transport::PrivateHttp));
        assert_eq!(vet(false, &[ip("100.64.0.1")]), Ok(Transport::Tailscale));
        assert_eq!(vet(false, &[ip("100.127.255.254")]), Ok(Transport::Tailscale));
        assert_eq!(vet(false, &[ip("fd7a:115c:a1e0::1")]), Ok(Transport::Tailscale));
        assert_eq!(vet(false, &[ip("fd00::1")]), Ok(Transport::PrivateHttp));
        assert_eq!(vet(false, &[ip("::ffff:10.0.0.1")]), Ok(Transport::PrivateHttp));
        // a mix of allowed kinds is a private network
        assert_eq!(vet(false, &[ip("127.0.0.1"), ip("192.168.1.20")]), Ok(Transport::PrivateHttp));
        // plain http to a public address is refused, also when only one answer is public
        for public in ["203.0.113.9", "8.8.8.8", "100.128.0.1", "172.32.0.1", "169.254.1.1", "2001:db8::1", "fe80::1", "0.0.0.0", "::ffff:8.8.8.8"] {
            assert_eq!(vet(false, &[ip(public)]), Err(text::E2), "{public}");
        }
        assert_eq!(vet(false, &[ip("10.0.0.1"), ip("203.0.113.9")]), Err(text::E2), "a name with one public answer");
        assert_eq!(vet(false, &[]), Err(text::E2), "no answer is not a private answer");
    }

    #[test]
    fn an_address_is_a_scheme_a_host_an_optional_port_and_an_optional_prefix() {
        let a = Address::parse("http://100.64.0.1:7430").unwrap();
        assert_eq!((a.tls, a.host.as_str(), a.port, a.prefix.as_str()), (false, "100.64.0.1", 7430, ""));
        assert_eq!(a.base(), "http://100.64.0.1:7430");
        assert_eq!(a.ws_base(), "ws://100.64.0.1:7430");
        let a = Address::parse(" https://Engine.Example/orgtree/ ").unwrap();
        assert_eq!((a.tls, a.host.as_str(), a.port, a.prefix.as_str()), (true, "engine.example", 443, "/orgtree"));
        assert_eq!(a.base(), "https://engine.example/orgtree");
        assert_eq!(a.ws_base(), "wss://engine.example/orgtree");
        let a = Address::parse("http://[fd7a:115c:a1e0::1]:7430/").unwrap();
        assert_eq!((a.host.as_str(), a.port), ("fd7a:115c:a1e0::1", 7430));
        assert_eq!(a.base(), "http://[fd7a:115c:a1e0::1]:7430");
        // no scheme: http, so the private-network rule still decides
        let a = Address::parse("localhost:7430").unwrap();
        assert_eq!((a.tls, a.host.as_str(), a.port), (false, "localhost", 7430));
        assert_eq!(Address::parse("http://localhost").unwrap().base(), "http://localhost");
    }

    #[test]
    fn user_info_query_fragment_and_other_schemes_are_refused() {
        for bad in ["", "   ", "ftp://host:1", "ws://host:1", "http://user@host:7430", "http://user:pw@host:7430", "http://host:7430/?x=1",
            "http://host:7430/#f", "http://", "http://host:99999", "http://ho st:1", "file:///c:/x"] {
            assert_eq!(Address::parse(bad), Err(text::E1), "{bad:?}");
        }
    }

    #[tokio::test]
    async fn an_ip_literal_resolves_to_itself_and_localhost_to_this_computer() {
        let a = Address::parse("http://10.9.8.7:7430").unwrap();
        assert_eq!(resolve(&a).await.unwrap(), vec!["10.9.8.7:7430".parse::<SocketAddr>().unwrap()]);
        let local = resolve(&Address::parse("http://localhost:7430").unwrap()).await.unwrap();
        let ips: Vec<IpAddr> = local.iter().map(|a| a.ip()).collect();
        assert_eq!(vet(false, &ips), Ok(Transport::Loopback), "{ips:?}");
    }
}

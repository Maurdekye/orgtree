//! MQTT topic filters (MQTT 3.1.1 §4.7): validation and matching. Our own
//! matcher, because rumqttc's refuses every `$` topic, even under `$SYS/#`.

/// Why `filter` is not a valid subscription filter, or None when it is.
#[logged]
pub fn invalid_filter(filter: &str) -> Option<&'static str> {
    if filter.is_empty() {
        return Some("the topic filter is empty");
    }
    if filter.len() > 65535 {
        return Some("the topic filter is longer than 65535 bytes");
    }
    if filter.contains('\0') {
        return Some("the topic filter contains a NUL character");
    }
    let levels: Vec<&str> = filter.split('/').collect();
    for (i, level) in levels.iter().enumerate() {
        if level.contains('#') && (*level != "#" || i + 1 != levels.len()) {
            return Some("`#` must be the whole last level of the filter, as in home/# (a/#/b and a/b# are invalid)");
        }
        if level.contains('+') && *level != "+" {
            return Some("`+` must be a whole level of the filter, as in home/+/temperature (home+/x is invalid)");
        }
    }
    None
}

/// Does a published `topic` match the subscription `filter`? `#` matches
/// the rest including its parent level (`a/#` matches `a`), `+` exactly one
/// level. A topic beginning with `$` is matched only by filters that do not
/// begin with a wildcard (§4.7.2): `$SYS/#` matches it, `#` does not.
#[nolog]
pub fn matches(filter: &str, topic: &str) -> bool {
    if topic.starts_with('$') && (filter.starts_with('+') || filter.starts_with('#')) {
        return false;
    }
    let mut f = filter.split('/');
    let mut t = topic.split('/');
    loop {
        match (f.next(), t.next()) {
            (Some("#"), _) => return true,
            (Some("+"), Some(_)) => {}
            (Some(a), Some(b)) if a == b => {}
            (None, None) => return true,
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_filters_pass_and_misplaced_wildcards_are_refused() {
        for ok in ["#", "+", "a", "a/b", "a/#", "a/+/c", "+/+", "/a", "a/", "$SYS/#", "home/+/temperature/#", "sport/tennis/player1"] {
            assert_eq!(invalid_filter(ok), None, "{ok}");
        }
        for bad in ["", "a/#/b", "a/b#", "#/a", "a+", "a/+b/c", "a/b+", "++", "a\0b"] {
            assert!(invalid_filter(bad).is_some(), "{bad:?} must be refused");
        }
        assert!(invalid_filter(&"a".repeat(65536)).is_some());
    }

    #[test]
    fn matching_follows_the_specification_examples() {
        // MQTT 3.1.1 §4.7.1.2 and §4.7.1.3
        assert!(matches("sport/tennis/player1/#", "sport/tennis/player1"));
        assert!(matches("sport/tennis/player1/#", "sport/tennis/player1/ranking"));
        assert!(matches("sport/tennis/player1/#", "sport/tennis/player1/score/wimbledon"));
        assert!(matches("sport/#", "sport"));
        assert!(matches("#", "a/b/c"));
        assert!(matches("sport/tennis/+", "sport/tennis/player1"));
        assert!(!matches("sport/tennis/+", "sport/tennis/player1/ranking"));
        assert!(!matches("sport/tennis/+", "sport/tennis"));
        assert!(matches("sport/+", "sport/"));
        assert!(!matches("sport/+", "sport"));
        assert!(matches("+/+", "/finance"));
        assert!(matches("/+", "/finance"));
        assert!(!matches("+", "/finance"));
        assert!(matches("a/b", "a/b"));
        assert!(!matches("a/b", "a/b/c"));
        assert!(!matches("a/b/c", "a/b"));
        assert!(!matches("a/b", "A/b"), "topics are case sensitive");
    }

    #[test]
    fn dollar_topics_match_only_filters_that_name_them() {
        // §4.7.2: rumqttc's matcher refuses all of these, so $SYS/# never fired
        assert!(matches("$SYS/#", "$SYS/broker/uptime"));
        assert!(matches("$SYS/broker/+", "$SYS/broker/uptime"));
        assert!(!matches("#", "$SYS/broker/uptime"));
        assert!(!matches("+/monitor/Clients", "$SYS/monitor/Clients"));
        assert!(matches("a/$x", "a/$x"), "a $ past the first level is ordinary");
    }
}

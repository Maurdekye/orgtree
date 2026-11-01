//! A project's theme colour and icon (USER 2026-10-28 10:27:49Z
//! m1c0bc6c121e9): stored in its scope like its other settings, read back
//! only in their valid shape, so a stored value nothing would accept today
//! draws as the folder in the default colour rather than as itself.

use serde_json::json;

use super::{theme_color, theme_icon, valid_theme_color, valid_theme_icon};

#[test]
fn a_colour_is_a_six_digit_hex_with_its_hash() {
    for ok in ["#e11d48", "#E11D48", "#000000", "#ffFFff"] {
        assert!(valid_theme_color(ok), "refused {ok}");
    }
    for bad in ["e11d48", "#e11d4", "#e11d488", "#e11d4g", "", "rose", "#e11d48 ", " #e11d48"] {
        assert!(!valid_theme_color(bad), "accepted {bad}");
    }
}

#[test]
fn an_icon_is_a_short_lowercase_slug() {
    for ok in ["rocket", "folder", "a", "snow-flake2"] {
        assert!(valid_theme_icon(ok), "refused {ok}");
    }
    for bad in ["", "Rocket", "rocket ship", "rocket_ship", "../rocket", "rocket!", "-rocket", "rocket-"] {
        assert!(!valid_theme_icon(bad), "accepted {bad}");
    }
    assert!(!valid_theme_icon(&"x".repeat(41)), "accepted a 41-char slug");
    assert!(valid_theme_icon(&"x".repeat(40)), "refused a 40-char slug");
}

#[test]
fn the_theme_reads_back_normalised_or_not_at_all() {
    let scope = json!({"theme_color": "#E11D48", "theme_icon": "rocket"});
    assert_eq!(theme_color(&scope).as_deref(), Some("#e11d48"));
    assert_eq!(theme_icon(&scope).as_deref(), Some("rocket"));
    assert_eq!(theme_color(&json!({})), None);
    assert_eq!(theme_icon(&json!({})), None);
    assert_eq!(theme_color(&json!({"theme_color": "rose"})), None);
    assert_eq!(theme_color(&json!({"theme_color": 7})), None);
    assert_eq!(theme_icon(&json!({"theme_icon": "Rocket"})), None);
    assert_eq!(theme_icon(&json!({"theme_icon": null})), None);
}

//! Default saved-panel labels (user 2026-10-26: "the default name for the panel
//! should not be the same as the app, thats confusing"): "Panel N", the lowest
//! number no saved copy of the same app already uses. Only exact automatic
//! labels hold a number; renamed, imported, duplicated and explicit labels
//! never shift one.

/// `labels` are the app's current saved-panel labels. Callers hold the app row
/// lock, so two concurrent creations cannot pick the same number.
#[nolog]
pub(crate) fn default_panel_label<'a>(labels: impl IntoIterator<Item = &'a str>) -> String {
    let used: std::collections::HashSet<u64> = labels.into_iter().filter_map(number).collect();
    let n = (1u64..).find(|n| !used.contains(n)).expect("a finite set leaves a free number");
    format!("Panel {n}")
}

/// The N of an exact automatic label: "Panel ", then a positive decimal
/// number without leading zeros or any other text.
#[nolog]
fn number(label: &str) -> Option<u64> {
    let digits = label.strip_prefix("Panel ")?;
    if digits.is_empty() || digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::default_panel_label as label;

    #[test]
    fn custom_apps_default_panel_label_is_the_lowest_unused_number_per_app() {
        assert_eq!(label(std::iter::empty()), "Panel 1");
        assert_eq!(label(["Panel 1"]), "Panel 2");
        assert_eq!(label(["Panel 2"]), "Panel 1");
        assert_eq!(label(["Panel 1", "Panel 3"]), "Panel 2");
        assert_eq!(label(["Panel 2", "Panel 1", "Panel 3"]), "Panel 4");
        // Explicit, renamed, duplicated and look-alike labels hold no number.
        let others = ["Notes", "Panel 1 copy", "Panel 01", "Panel  2", "panel 1", "Panel 1.5", "Panel -1", "Panel 0", "Panel ", "Panel"];
        assert_eq!(label(others), "Panel 1");
        // The app's own name is never the default.
        assert_ne!(label(["Caption placement"]), "Caption placement");
        // A number too large to read holds nothing and skips no gap below it.
        assert_eq!(label(["Panel 1", "Panel 99999999999999999999999"]), "Panel 2");
    }
}

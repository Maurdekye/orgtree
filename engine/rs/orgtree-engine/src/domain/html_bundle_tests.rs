use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(crate::util::uid("html-asset-error-"));
        std::fs::create_dir_all(&dir).unwrap();
        Self(crate::config::strip_verbatim(&std::fs::canonicalize(dir).unwrap()))
    }
    fn write(&self, name: &str, content: &str) -> PathBuf {
        let path = self.0.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Only this test's uniquely created directory, never a caller's path.
        let root = crate::config::strip_verbatim(&std::fs::canonicalize(std::env::temp_dir()).unwrap());
        assert_eq!(self.0.parent(), Some(root.as_path()));
        assert!(self.0.file_name().unwrap().to_string_lossy().starts_with("html-asset-error-"));
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn diagnostic(error: anyhow::Error) -> String {
    // Match orgtree_present's tool boundary, including its UserError path.
    match error.downcast_ref::<crate::domain::UserError>() {
        Some(error) => error.to_string(),
        None => format!("{error:#}"),
    }
}
fn assert_asset_error(source: &Path, raw: &str, resolved: &Path, referring: &Path) {
    let error = diagnostic(capture(source).expect_err("missing/unreadable local assets must refuse"));
    assert!(error.contains(raw), "missing reference as written {raw:?}: {error}");
    assert!(error.contains(&resolved.display().to_string()), "missing resolved path {}: {error}", resolved.display());
    assert!(error.contains(&referring.display().to_string()), "missing referring file {}: {error}", referring.display());
}

#[test]
fn missing_link_href_names_reference_resolved_path_and_html() {
    let f = Fixture::new();
    let source = f.write("mockup.html", r#"<link rel="stylesheet" href="missing/site.css">"#);
    assert_asset_error(&source, "missing/site.css", &f.0.join("missing/site.css"), &source);
}
#[test]
fn missing_inline_import_names_katex_and_html() {
    let f = Fixture::new();
    let source = f.write("mockup.html", "<style>@import 'katex/dist/katex.min.css';</style>");
    assert_asset_error(&source, "katex/dist/katex.min.css", &f.0.join("katex/dist/katex.min.css"), &source);
}
#[test]
fn missing_nested_import_names_its_css_not_just_the_entry_html() {
    let f = Fixture::new();
    let source = f.write("mockup.html", r#"<link rel="stylesheet" href="styles/site.css">"#);
    let css = f.write("styles/site.css", "@import 'katex/dist/katex.min.css';");
    assert_asset_error(&source, "katex/dist/katex.min.css", &f.0.join("styles/katex/dist/katex.min.css"), &css);
}
#[test]
fn missing_css_url_names_its_css_and_original_query() {
    let f = Fixture::new();
    let source = f.write("mockup.html", r#"<link rel="stylesheet" href="styles/site.css">"#);
    let css = f.write("styles/site.css", "p { background: url('missing%20image.png?v=2#mask') }");
    assert_asset_error(&source, "missing%20image.png?v=2#mask", &f.0.join("styles/missing image.png"), &css);
}
#[test]
fn missing_src_keeps_reference_entities_as_written() {
    let f = Fixture::new();
    let source = f.write("mockup.html", r#"<img src="missing%20image.png?v=1&amp;x=2">"#);
    assert_asset_error(&source, "missing%20image.png?v=1&amp;x=2", &f.0.join("missing image.png"), &source);
}
#[test]
fn directory_asset_keeps_context_at_the_user_error_boundary() {
    let f = Fixture::new();
    let source = f.write("mockup.html", r#"<script src="not-a-file"></script>"#);
    std::fs::create_dir(f.0.join("not-a-file")).unwrap();
    assert_asset_error(&source, "not-a-file", &f.0.join("not-a-file"), &source);
}
#[test]
fn successful_capture_still_inlines_nested_local_assets() {
    let f = Fixture::new();
    let source = f.write("mockup.html", r#"<link rel="stylesheet" href="styles/site.css"><img src="image.png">"#);
    f.write("styles/site.css", "@import 'base.css';p{background:url('mark.svg')}");
    f.write("styles/base.css", "p{color:red}");
    f.write("styles/mark.svg", "<svg></svg>");
    f.write("image.png", "synthetic image bytes");
    let bundle = capture(&source).unwrap();
    assert!(bundle.preview.contains("data:text/css;base64,"));
    assert!(bundle.preview.contains("data:image/png;base64,"));
    assert!(bundle.download.is_some());
}
#[test]
fn protected_assets_still_refuse_instead_of_being_read() {
    let f = Fixture::new();
    let source = f.write("mockup.html", r#"<script src=".env"></script>"#);
    f.write(".env", "synthetic protected content");
    let error = capture(&source).unwrap_err();
    assert!(matches!(error.downcast_ref(), Some(crate::domain::UserError::Forbidden(_))));
}

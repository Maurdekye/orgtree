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

// FOLLOW-UP (@item:orgtree/project-themes-colour-the-whole-project-node-by-i;
// USER 2026-11-03 09:22:44Z mc4fd305e1c09 "2 shouls be able to uplosd a cuwtom
// icon"): an uploaded icon is a normalised PNG kept in its own bounded record;
// the scope (and so the tree) carries only its SHA-256, the image's cache key.

use super::{theme_icon_custom, valid_theme_icon_custom};

#[test]
fn an_uploaded_icon_is_named_by_its_sha256() {
    assert!(valid_theme_icon_custom(&"a".repeat(64)));
    assert!(valid_theme_icon_custom(&"0123456789abcdef".repeat(4)));
    for bad in ["".to_string(), "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), format!("{}/", "a".repeat(63))] {
        assert!(!valid_theme_icon_custom(&bad), "accepted {bad}");
    }
    assert_eq!(theme_icon_custom(&json!({"theme_icon_custom": "a".repeat(64)})), Some("a".repeat(64)));
    assert_eq!(theme_icon_custom(&json!({"theme_icon_custom": "rocket"})), None);
    assert_eq!(theme_icon_custom(&json!({})), None);
}

mod upload {
    use std::io::Cursor;
    use image::{DynamicImage, GenericImageView, ImageFormat, Rgba, RgbaImage};
    use crate::profile_pictures::image::{normalize_icon, ICON_SIZE, MAX_ICON_INPUT_BYTES};

    fn encoded(image: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        image.write_to(&mut out, format).unwrap();
        out.into_inner()
    }

    #[test]
    fn png_jpeg_and_webp_become_a_256_square_png_with_the_aspect_kept() {
        assert_eq!(ICON_SIZE, 256);
        // a wide red picture: centred, letterboxed with transparency above and below
        let wide = DynamicImage::ImageRgba8(RgbaImage::from_pixel(1000, 500, Rgba([200, 0, 0, 255])));
        for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::WebP] {
            let raw = if format == ImageFormat::Jpeg {
                encoded(&DynamicImage::ImageRgb8(wide.to_rgb8()), format)
            } else { encoded(&wide, format) };
            let png = normalize_icon(&raw).unwrap_or_else(|e| panic!("{format:?}: {e}"));
            crate::profile_pictures::wire::validate_png(&png, ICON_SIZE).unwrap();
            let out = image::load_from_memory_with_format(&png, ImageFormat::Png).unwrap();
            assert_eq!(out.dimensions(), (256, 256), "{format:?}");
            assert_eq!(out.get_pixel(128, 2)[3], 0, "{format:?}: the band above a wide picture is transparent");
            assert_eq!(out.get_pixel(128, 253)[3], 0, "{format:?}: and the band below");
            let mid = out.get_pixel(128, 128);
            assert!(mid[3] == 255 && mid[0] > 150, "{format:?}: the picture fills the middle: {mid:?}");
        }
        // a small square is scaled up to fill the square
        let small = DynamicImage::ImageRgba8(RgbaImage::from_pixel(16, 16, Rgba([0, 0, 200, 255])));
        let out = image::load_from_memory(&normalize_icon(&encoded(&small, ImageFormat::Png)).unwrap()).unwrap();
        assert_eq!(out.get_pixel(1, 1)[3], 255, "no border on a square picture");
    }

    #[test]
    fn svg_gif_garbage_and_oversized_input_are_refused_with_a_clear_message() {
        assert_eq!(MAX_ICON_INPUT_BYTES, 2 * 1024 * 1024);
        let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>"#;
        let gif = b"GIF89a\x01\x00\x01\x00\x00\x00\x00;".to_vec();
        for bad in [svg.to_vec(), gif, b"not an image".to_vec()] {
            let err = normalize_icon(&bad).unwrap_err().to_string();
            assert!(err.contains("PNG, JPEG, WebP"), "names the formats: {err}");
        }
        let mut big = encoded(&DynamicImage::new_rgba8(4, 4), ImageFormat::Png);
        big.resize(MAX_ICON_INPUT_BYTES + 1, 0);
        let err = normalize_icon(&big).unwrap_err().to_string();
        assert!(err.contains("2 MB"), "names the size limit: {err}");
    }
}

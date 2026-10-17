//! Custom tags for mail addressed to the user; policy is separate from routing.
use anyhow::Result;
use serde_json::Value;

#[nolog]
pub fn normalize(value: Option<&Value>) -> Result<Vec<String>> {
    Ok(value.and_then(Value::as_array).into_iter().flatten()
        .filter_map(Value::as_str).map(str::to_string).collect())
}

#[nolog]
pub fn recipient(_to: &str, _tags: &[String]) -> Result<()> { Ok(()) }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn trim_dedupe_case_insensitively_keep_first_spelling() {
        assert_eq!(normalize(Some(&json!([" Alpha Build ","alpha build","Progress"]))).unwrap(),vec!["Alpha Build","Progress"]);
    }
    #[test]
    fn eight_tags_allowed_ninth_refused() {
        assert_eq!(normalize(Some(&json!(["a","b","c","d","e","f","g","h"]))).unwrap().len(),8);
        assert!(normalize(Some(&json!(["a","b","c","d","e","f","g","h","i"]))).is_err());
    }
    #[test]
    fn length_counts_characters_not_utf8_bytes_and_blank_refused() {
        assert!(normalize(Some(&json!(["\u{e9}".repeat(32)]))).is_ok());
        assert!(normalize(Some(&json!(["x".repeat(33)]))).is_err());
        assert!(normalize(Some(&json!(["   "]))).is_err());
    }
    #[test]
    fn shape_requires_strings_in_an_array() {
        for v in [json!("build"),json!([1]),json!({})] { assert!(normalize(Some(&v)).is_err()); }
        assert!(normalize(None).unwrap().is_empty());
        assert!(normalize(Some(&json!([]))).unwrap().is_empty());
    }
    #[test]
    fn tagged_recipients_are_only_user_but_untagged_routes_unchanged() {
        let tags=vec!["alpha build".to_string()];
        assert!(recipient("user",&tags).is_ok());assert!(recipient(" @user ",&tags).is_ok());
        for to in ["peer","@org:other","@net:remote"] {
            let e=recipient(to,&tags).expect_err("tagged non-user delivery must refuse before transport");
            assert!(e.to_string().contains("only for mail to the user"));
            assert!(recipient(to,&[]).is_ok());
        }
    }
    #[test]
    fn inbox_projection_carries_joined_labels_without_tagging_legacy_mail() {
        let old=json!({"uid":"old","sender":"lead","body":"old","kind":"message","created_at":"2026-10-17T00:00:00Z"});
        let mut tagged=old.clone();tagged["tags"]=json!(["Alpha Build"]);
        assert_eq!(crate::feed::compute::mail_entry(&tagged)["tags"],json!(["Alpha Build"]));
        assert!(crate::feed::compute::mail_entry(&old).get("tags").is_none());
    }
}

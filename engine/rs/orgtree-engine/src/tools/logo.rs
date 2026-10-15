//! Autonomous org Logo edits; images stay outside automatic tool/trace values.
use super::Done;
use crate::{
    domain::{docs, undo},
    engine::Engine,
    profile_pictures as pictures,
    runtime::Caller,
};
use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;
use std::{io::Read, path::PathBuf, sync::Arc};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    action: String,
    path: Option<String>,
    crop: Option<pictures::image::Crop>,
}

#[logged]
fn input(args: &Value) -> Result<Input> {
    let input: Input = serde_json::from_value(args.clone()).map_err(|_| {
        crate::domain::UserError::BadRequest(
            "expected action set/remove, optional path and crop {x,y,size}".into(),
        )
    })?;
    match input.action.as_str() {
        "set" if input.path.as_deref().is_some_and(|p| !p.trim().is_empty()) => {}
        "set" => crate::refuse!(BadRequest, "set requires a local image path"),
        "remove" if input.path.is_none() && input.crop.is_none() => {}
        "remove" => crate::refuse!(BadRequest, "remove takes no path or crop"),
        _ => crate::refuse!(BadRequest, "action must be set or remove"),
    }
    Ok(input)
}

/// Bounded reads also handle a file growing after metadata was checked.
#[nolog]
fn read(p: &docs::Presenter, raw: &str) -> Result<(PathBuf, Vec<u8>)> {
    let path = docs::readable(p, raw)?;
    let file = std::fs::File::open(&path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        crate::refuse!(BadRequest, "Logo input must be a regular image file");
    }
    if meta.len() > pictures::wire::MAX_INPUT_BYTES as u64 {
        crate::refuse!(BadRequest, "Logo image exceeds 5 MiB");
    }
    let mut bytes = Vec::new();
    file.take(pictures::wire::MAX_INPUT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > pictures::wire::MAX_INPUT_BYTES {
        crate::refuse!(BadRequest, "Logo image exceeds 5 MiB");
    }
    Ok((path, bytes))
}

#[logged]
pub async fn run(engine: &Arc<Engine>, caller: &Caller, args: &Value) -> Result<Done> {
    let input = input(args)?;
    let org = engine
        .orgs
        .by_id(caller.org_id)
        .ok_or_else(|| crate::domain::UserError::NotFound("organization not open".into()))?;
    let generation = {
        let client = engine.db.get().await?;
        let row=client.query_opt("SELECT generation FROM ot.agents WHERE id=$1 AND org_id=$2 AND name=$3 AND state='live'",
            &[&caller.agent_id,&org.id,&caller.name]).await?;
        let Some(row) = row else {
            crate::refuse!(
                Forbidden,
                "the calling agent is no longer live in this organization"
            );
        };
        row.get::<_, i32>(0)
    };
    let (source, bytes) = if let Some(raw) = &input.path {
        let presenter = docs::presenter(engine, &org, caller.agent_id).await?;
        let raw = raw.clone();
        let (path, bytes) = tokio::task::spawn_blocking(move || read(&presenter, &raw)).await??;
        (Some(path), Some(bytes))
    } else {
        (None, None)
    };
    let record=pictures::image::prepare(bytes,input.crop.unwrap_or_default()).await
        .map_err(|_|crate::domain::UserError::BadRequest("Choose a static PNG, JPEG or WebP up to 5 MiB and 16 megapixels, with a valid square crop".into()))?;
    // Decode before locking. Recheck caller, inherited tools and folder authority
    // in the picture+journal transaction, so a winning scope change is honored.
    let result = undo::logo(
        engine,
        &org,
        caller,
        generation,
        record,
        input.path.as_deref().zip(source.as_deref()),
    )
    .await?;
    Done::json(&result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn requests_are_unambiguous_and_cannot_select_another_org() {
        for args in [
            json!({}),
            json!({"action":"set"}),
            json!({"action":"remove","path":"image.png"}),
            json!({"action":"remove","org":"other"}),
            json!({"action":"set","path":"a","crop":{"x":0}}),
        ] {
            assert!(input(&args).is_err());
        }
        assert!(input(&json!({"action":"remove"})).is_ok());
        assert!(input(
            &json!({"action":"set","path":"logo.png","crop":{"x":0.5,"y":0.5,"size":1}})
        )
        .is_ok());
    }
}

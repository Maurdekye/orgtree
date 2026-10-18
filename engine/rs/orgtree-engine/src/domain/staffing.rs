//! Staffing work: `orgtree_staff` (a docket item and its new owner in one
//! call) and the user's Quick staff on a backlogged ticket — ask its assignee
//! to staff it, or hire under the assignee or at the top level right away.

use std::sync::Arc;

use anyhow::Result;
use chrono::Utc;
use serde_json::{json, Value};

use crate::domain::docket::{self, Who};
use crate::domain::mail::{self, From, Outgoing};
use crate::domain::ops::{self, Actor};
use crate::engine::Engine;
use crate::orgs::OrgHandle;
use crate::providers::catalog;
use crate::refuse;
use crate::util::{gist, slugify};

/// A tier a new hire can take now.
#[derive(Debug)]
struct Offer {
    tier: String,
    seat: f64,
    provider: &'static str,
    efforts: Vec<&'static str>,
}

/// Tiers this build can run for a new hire: each installed, enabled CLI's
/// current tiers, and the OpenRouter favorites while a key is stored.
#[logged]
fn runnable_tiers(engine: &Engine, org_slug: &str) -> Vec<Offer> {
    let st = engine.providers.state.load();
    let view = engine.accounts.view();
    let mut out: Vec<Offer> = catalog::listed()
        .iter()
        .copied()
        // a Muse tier is conditional on a Muse login's own catalog: the user's
        // own, or a registered one (primary entitlement is no prerequisite)
        .filter(|t| !t.legacy && (!t.conditional || (t.provider == catalog::MUSE && muse_somewhere(engine, t.tier))
                || (t.provider == catalog::GOOGLE && crate::providers::agy_offered(engine, t.tier)))
            && engine.settings.provider_enabled(t.provider))
        .filter(|t| !catalog::antigravity_claude(t.tier) || engine.settings.antigravity_claude_enabled())
        // Native exhaustion cannot hide a tier another eligible profile
        // can serve. Keep the native choice gated separately below.
        .filter(|t| crate::usage::antigravity_limit(engine, t.tier).is_none()
            || eligible_accounts(engine, t.tier, org_slug).iter().any(|a| matches!(
                crate::providers::agy_auth::login_of(&view, a["id"].as_str()),
                crate::providers::agy_auth::Login::Profile { .. })))
        .filter(|t| match t.provider {
            catalog::CLAUDE => st.claude.installed,
            catalog::OPENAI => st.codex.installed,
            catalog::GOOGLE => st.agy.installed,
            catalog::MUSE => st.muse.installed,
            _ => false,
        })
        .map(|t| Offer { tier: t.tier.to_string(), seat: t.seat, provider: t.provider,
                         efforts: if t.provider == catalog::MUSE { muse_efforts(engine, t) } else { efforts(t, &st) } })
        .collect();
    let key_set = engine.settings.get().pointer("/openrouter/key_set").and_then(Value::as_bool).unwrap_or(false);
    if key_set && engine.settings.provider_enabled(catalog::OPENROUTER) {
        for (tier, seat, _) in engine.providers.openrouter_tiers() {
            out.push(Offer { tier, seat, provider: catalog::OPENROUTER, efforts: catalog::EFFORTS.to_vec() });
        }
    }
    // the offered models of every enabled language server whose harness is
    // installed (no effort: a local model's reasoning switch is its own)
    if engine.settings.provider_enabled(catalog::LANGSERVER) {
        for (tier, seat, _, _, _) in crate::langserver::tiers(engine) {
            let harness_ok = crate::langserver::route_of(engine, &tier)
                .map(|(s, _)| crate::harnesses::installed(engine, s["harness"].as_str().unwrap_or("claude-code")))
                .unwrap_or(false);
            if harness_ok {
                out.push(Offer { tier, seat, provider: catalog::LANGSERVER, efforts: Vec::new() });
            }
        }
    }
    out
}

/// A lane that bills no account: the user's own language servers. Its hires
/// name no account and need no sign-in. (OpenRouter's keys are accounts
/// since several keys, ruling 2026-10-11: a hire naming none is placed on a
/// key, every key alike.)
#[nolog]
fn accountless(provider: &str) -> bool {
    provider == catalog::LANGSERVER
}

/// `host_ready`, and the org has not switched that lane off (its provider's
/// own login, any OpenRouter key, or a language server's lane).
#[logged]
fn host_for(engine: &Engine, org_slug: &str, tier: &str, provider: &str) -> bool {
    // a hire naming no OpenRouter key is placed on a key (balancing at
    // placement): one must be stored, active, used by the org and on an
    // installed harness (installed-only ruling 2026-10-13: every staffing
    // surface offers only what can launch)
    if provider == catalog::OPENROUTER {
        return host_ready(engine, provider) && crate::openrouter::keys(engine).iter().any(|a| a.enabled
            && a.available_to(Some(org_slug))
            && crate::harnesses::installed(engine, &crate::openrouter::key_harness(engine, &a.id)));
    }
    let lane = crate::org_accounts::tier_lane(engine, tier).unwrap_or_else(|| crate::org_accounts::primary(provider));
    host_ready(engine, provider) && crate::org_accounts::allowed(Some(org_slug), &lane)
}

/// Whether a hire that names no account can run `provider`: the host login
/// is signed in and subscriptions may serve inference (an OpenRouter seat
/// bills the stored key).
#[logged]
fn host_ready(engine: &Engine, provider: &str) -> bool {
    let st = engine.providers.state.load();
    let signed_in = match provider {
        catalog::OPENROUTER | catalog::LANGSERVER => return true,
        catalog::CLAUDE => st.claude.connected,
        catalog::OPENAI => st.codex.connected,
        catalog::GOOGLE => st.agy.installed,
        catalog::MUSE => st.muse.connected,
        _ => false,
    };
    signed_in && engine.settings.subscription_inference(provider)
}

/// The tier's own harness and model's level names (`providers::effort_names`),
/// lowest first; none while they are not known.
#[logged]
fn efforts(t: &catalog::Tier, state: &crate::providers::State) -> Vec<&'static str> {
    let names = crate::providers::effort_names(state, t.tier).unwrap_or_default();
    catalog::EFFORT_ORDER.iter().copied().filter(|e| names.iter().any(|n| n == e)).collect()
}

/// Whether some Muse login offers `tier`: the user's own, or a registered,
/// enabled one, by its own catalog as last read.
#[logged]
fn muse_somewhere(engine: &Engine, tier: &str) -> bool {
    let model = catalog::model_for(tier, None);
    crate::providers::muse_offered(engine, tier)
        || engine.accounts.view().all().into_iter().filter(|a| a.provider == catalog::MUSE && a.enabled)
            .any(|a| matches!(crate::providers::muse_offer(engine, Some(a), &model), crate::providers::MuseOffer::Offered(_)))
}

/// A Muse tier's level names: every level some login that offers the tier
/// names for its model (the user's own and each registered one switched on,
/// each by its own catalog row). Each eligible account carries its own
/// (`eligible_accounts`), and a hire is checked again against the login it
/// lands on.
#[logged]
fn muse_efforts(engine: &Engine, t: &catalog::Tier) -> Vec<&'static str> {
    let view = engine.accounts.view();
    let names: Vec<String> = std::iter::once(crate::providers::effort_names_on(engine, t.tier, None, None))
        .chain(view.all().into_iter().filter(|a| a.provider == catalog::MUSE && a.enabled)
            .map(|a| crate::providers::effort_names_on(engine, t.tier, None, Some(a))))
        .flatten().flatten().collect();
    catalog::EFFORT_ORDER.iter().copied().filter(|e| names.iter().any(|n| n == e)).collect()
}

/// The login a hire that names no account runs on: the org's default
/// account when it can serve `tier`, else the provider's own sign-in (None).
#[logged]
fn default_login(engine: &Engine, org_default: Option<&str>, tier: &str) -> Option<crate::accounts::AccountInfo> {
    let crate::accounts::Choice::Account(id) = crate::accounts::choice(org_default) else { return None };
    engine.accounts.view().get(&id).filter(|a| a.provider == catalog::provider_of(tier)).cloned()
}

/// The org's hire default account (`settings.default_account`), if any.
#[logged]
async fn org_default(engine: &Engine, org: &OrgHandle) -> Result<Option<String>> {
    let client = engine.db.get().await?;
    let settings: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org.id]).await?.get(0);
    Ok(settings["default_account"].as_str().map(str::to_string))
}

/// Accounts that can run `provider` now: enabled, signed in, not at a limit
/// (no mark, and no window the tier spends at 100% in the latest reading).
#[logged]
fn eligible_accounts(engine: &Engine, tier: &str, org_slug: &str) -> Vec<Value> {
    let provider = catalog::provider_of(tier);
    let now = Utc::now();
    let view = engine.accounts.view();
    let mut out: Vec<Value> = view
        .all()
        .into_iter()
        .filter(|a| {
            a.provider == provider
                // a key whose harness is not installed cannot launch its seats
                && (a.provider != catalog::OPENROUTER
                    || crate::harnesses::installed(engine, &crate::openrouter::key_harness(engine, &a.id)))
                && a.available_to(Some(org_slug))
                && crate::accounts::active(engine, provider, Some(a))
                && a.auth != "signed_out"
                && a.limited_for(tier, now).is_none()
                && crate::usage::at_limit(engine, Some(a), tier).is_none()
                // a Muse login offers the tier by its own catalog, never by another's
                && (provider != catalog::MUSE || matches!(
                    crate::providers::muse_offer(engine, Some(a), &catalog::model_for(tier, None)), crate::providers::MuseOffer::Offered(_)))
        })
        .map(|a| {
            let mut v = json!({ "value": a.id, "id": a.id, "provider": a.provider, "ambient": false, "email": a.email,
                                "kind": if a.is_apikey() { "apikey" } else { "subscription" } });
            // an OpenRouter key has no email: the pickers show its name
            if a.provider == catalog::OPENROUTER {
                v["label"] = json!(crate::openrouter::display(engine, a));
            }
            // a Muse login's own levels for the tier's model, from its catalog
            // row (the tier's `efforts` are every level some login takes)
            if a.provider == catalog::MUSE {
                v["efforts"] = json!(crate::providers::effort_names_on(engine, tier, None, Some(a)).unwrap_or_default());
            }
            v
        })
        .collect();
    out.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    out
}

/// Where Quick staff will put the seat for this ticket, and what it says.
#[logged]
async fn quick_context(engine: &Engine, org: &OrgHandle, slug: &str) -> Result<(Value, Value)> {
    let item = docket::user_get(engine, org, slug).await?;
    if item["archived"].as_bool().unwrap_or(false) || item["status"].as_str() != Some("backlogged") {
        refuse!(Unprocessable, "Quick staff is available only for backlogged tickets. Reopen the menu.");
    }
    let owner = item["owner"].clone();
    let live = item["owner_state"].as_str() == Some("live");
    let configured = engine.settings.quick_staff_behavior();
    let fallback = configured != "top_level" && !live;
    let mode = if fallback { "top_level".to_string() } else { configured.clone() };
    let disclosure = if fallback {
        "Assignee unavailable — selected agent will be staffed immediately at top level. Choose a model."
    } else if mode == "request" {
        "Request staffing from the assignee."
    } else if mode == "under_assignee" {
        "Staff immediately under the assignee. Choose a model."
    } else {
        "Staff immediately at top level. Choose a model."
    };
    let ctx = json!({ "mode": mode, "configured_mode": configured,
                      "owner": if owner.is_object() { owner } else { json!({}) },
                      "fallback": fallback, "disclosure": disclosure });
    Ok((item, ctx))
}

/// `GET …/quick-staff`: only the models that can actually be staffed.
#[logged]
pub async fn quick_preview(engine: &Engine, org: &OrgHandle, slug: &str) -> Result<Value> {
    let (_item, mut ctx) = quick_context(engine, org, slug).await?;
    let request = ctx["mode"] == "request";
    let org_default = org_default(engine, org).await?;
    let models: Vec<Value> = runnable_tiers(engine, &org.slug)
        .into_iter()
        .filter_map(|t| {
            let mut m = json!({ "tier": t.tier, "seat": t.seat, "efforts": t.efforts });
            if !request {
                let accounts = if accountless(t.provider) { Vec::new() } else { eligible_accounts(engine, &t.tier, &org.slug) };
                // the user's hard rule: never a model on a login whose window it spends is at 100%
                let host = host_for(engine, &org.slug, &t.tier, t.provider)
                    && (t.provider != catalog::MUSE || crate::providers::muse_offered(engine, &t.tier))
                    && (accountless(t.provider)
                        || crate::usage::at_limit(engine, default_login(engine, org_default.as_deref(), &t.tier).as_ref(), &t.tier).is_none());
                if accounts.is_empty() && !host {
                    return None;
                }
                m["accounts"] = json!(accounts);
                m["default_ok"] = json!(host);
            }
            Some(m)
        })
        .collect();
    ctx["models"] = json!(models);
    ctx["availability"] = availability(engine);
    Ok(ctx)
}

/// `POST …/quick-staff`: commit the selection (idempotent per request id).
#[logged]
pub async fn quick_commit(engine: &Arc<Engine>, org: &Arc<OrgHandle>, slug: &str, body: &Value) -> Result<Value> {
    let request_id = body["request_id"].as_str().unwrap_or("").to_string();
    let selection = json!({ "mode": body["mode"], "configured_mode": body["configured_mode"], "owner": body["owner"],
                            "tier": body["tier"], "effort": body["effort"], "account": body["account"] });
    // a retried request answers what it did the first time
    if !request_id.is_empty() {
        let client = engine.db.get().await?;
        let prev: Option<Value> = client
            .query_opt(
                "SELECT extra->'quick_staff'->$3 FROM ot.work_items WHERE org_id = $1 AND slug = $2",
                &[&org.id, &slug, &request_id],
            )
            .await?
            .and_then(|r| r.get::<_, Option<Value>>(0))
            .filter(|v| !v.is_null());
        if let Some(p) = prev {
            if p["selection"] != selection {
                refuse!(Unprocessable, "That staffing request id already belongs to a different selection.");
            }
            let mut r = p["result"].clone();
            r["replayed"] = json!(true);
            return Ok(r);
        }
    }
    let (item, ctx) = quick_context(engine, org, slug).await?;
    for k in ["mode", "configured_mode", "owner"] {
        if body[k] != ctx[k] {
            refuse!(Unprocessable, "The staffing behavior or assignee changed. Reopen the ticket menu to see where staffing will happen.");
        }
    }
    let tier = body["tier"].as_str().filter(|t| !t.is_empty());
    let effort = body["effort"].as_str().filter(|e| !e.is_empty());
    let account = body["account"].as_str().filter(|a| !a.is_empty());
    let mode = ctx["mode"].as_str().unwrap_or("request").to_string();
    if effort.is_some() && tier.is_none() {
        refuse!(Unprocessable, "Select a model before choosing an effort.");
    }
    if mode != "request" && tier.is_none() {
        refuse!(Unprocessable, "Immediate staffing requires a model. Reopen Staff… and select one.");
    }
    if account.is_some() && mode == "request" {
        refuse!(Unprocessable, "Request staffing cannot pin an account — the assignee makes that choice when it hires.");
    }
    if let Some(t) = tier {
        let Some(info) = runnable_tiers(engine, &org.slug).into_iter().find(|x| x.tier == t) else {
            refuse!(Unprocessable, "{t} cannot be staffed right now. Reopen Staff….");
        };
        if let Some(e) = effort {
            if !info.efforts.contains(&e) {
                refuse!(Unprocessable, "That effort is not currently supported by this model. Reopen Staff….");
            }
        }
        // the commit asks the menu's question again (3.x staffcache): never a
        // model on a login whose window it spends is at 100%
        if mode != "request" && !accountless(info.provider) {
            match account {
                Some(a) if !eligible_accounts(engine, t, &org.slug).iter().any(|x| x["id"].as_str() == Some(a)) => {
                    refuse!(Conflict, "{a} cannot run {t} right now: it is signed out, off or at its limit. Reopen Staff….");
                }
                None => {
                    let dflt = default_login(engine, org_default(engine, org).await?.as_deref(), t);
                    if let Some(why) = crate::usage::at_limit(engine, dflt.as_ref(), t) {
                        refuse!(Conflict, "The default account for {t} is at 100% ({why}). Choose another account or wait for the reset.");
                    }
                }
                _ => {}
            }
        }
    }
    let item_slug = item["slug"].as_str().unwrap_or(slug).to_string();
    let title = item["title"].as_str().unwrap_or("").to_string();
    let result = if mode == "request" {
        let nid = ctx["owner"]["node"].as_str().unwrap_or("").to_string();
        let mut text = format!("Please staff the docket ticket {item_slug} ({title}).");
        if let Some(t) = tier {
            text.push_str(&format!(" Suggested model: {t}."));
        }
        if let Some(e) = effort {
            text.push_str(&format!(" Suggested effort: {e}."));
        }
        let mut done: Vec<Value> = item["done_so_far"].as_array().cloned().unwrap_or_default();
        let mut next: Vec<Value> = item["working_on_next"].as_array().cloned().unwrap_or_default();
        if done.is_empty() && next.is_empty() {
            next.push(json!("Staff the ticket."));
        }
        done.retain(|d| d.as_str().map(|s| !s.trim().is_empty()).unwrap_or(false));
        docket::update(engine, org, &Who::User, &json!({ "slug": item_slug, "status": "open", "done_so_far": done,
                                                          "working_on_next": next, "owner": nid })).await?;
        let mut out = Outgoing::new(From::User, &nid, &text);
        out.kind = "request".into();
        let sent = mail::send(engine, org.id, out).await?;
        json!({ "message": format!("Staffing requested from {nid}; ticket moved to Open."), "requested_from": nid, "mail": sent.uid })
    } else {
        let tier = tier.unwrap_or_default().to_string();
        let top = mode == "top_level";
        // the seat's name follows the ticket's title
        let base: String = slugify(&title, 40);
        let client = engine.db.get().await?;
        let mut name = base.clone();
        let mut n = 2;
        while client
            .query_opt("SELECT 1 FROM ot.agents WHERE org_id = $1 AND name = $2 AND state <> 'deleted'", &[&org.id, &name])
            .await?
            .is_some()
        {
            name = format!("{base}-{n}");
            n += 1;
        }
        let settings: Value = client.query_one("SELECT settings FROM ot.orgs WHERE id = $1", &[&org.id]).await?.get(0);
        drop(client);
        let eff = crate::feed::groups::effective_settings(&settings, &engine.settings.defaults());
        let mut req = json!({
            "op": "hire", "name": name, "tier": tier,
            "grant": if top { eff["default_top_grant"].as_f64().unwrap_or(20.0) } else { 0.0 },
            "charter": format!("Own the docket item {item_slug}: {title}. Read its full description and complete its requirements. Keep the docket current."),
        });
        let assignee = ctx["owner"]["node"].as_str().map(str::to_string);
        if !top {
            if let Some(a) = &assignee {
                req["parent"] = json!(a);
            }
        }
        if let Some(e) = effort {
            req["effort"] = json!(e);
        }
        if let Some(a) = account {
            req["account"] = json!(a);
        }
        req["staff_item"] = json!({ "action": "update", "slug": item_slug, "status": "open" });
        let hired = ops::run(engine, org, Actor::User, &req).await?;
        let node = hired["node"].as_str().unwrap_or(&name).to_string();
        let mut message = format!(
            "Staffed {node} {}{}; ticket moved to Open.",
            if top { "at top level".to_string() } else { format!("under {}", assignee.clone().unwrap_or_default()) },
            account.map(|a| format!(" on {a}")).unwrap_or_default()
        );
        let mut out = json!({ "node": node, "message": "" });
        if !top {
            if let Some(a) = &assignee {
                let mut notice = format!(
                    "[QUICK STAFFING · {item_slug} \"{}\"]\nThe user initiated immediate staffing beneath you, and {node} is now staffed under you. Selected model: {tier}.",
                    gist(&title, 80)
                );
                if let Some(e) = effort {
                    notice.push_str(&format!(" Selected effort: {e}."));
                }
                let mut m = Outgoing::new(From::User, a, &notice);
                m.notice = true;
                if mail::send(engine, org.id, m).await.is_ok() {
                    out["assignee_notified"] = json!(a);
                } else {
                    message.push_str(&format!(" ({a} could not be told.)"));
                }
            }
        }
        out["message"] = json!(message);
        out
    };
    if !request_id.is_empty() {
        let client = engine.db.get().await?;
        client
            .execute(
                "UPDATE ot.work_items SET extra = jsonb_set(extra || jsonb_build_object('quick_staff', coalesce(extra->'quick_staff', '{}'::jsonb)),
                                                           ARRAY['quick_staff', $3::text], $4)
                  WHERE org_id = $1 AND slug = $2",
                &[&org.id, &slug, &request_id, &json!({ "selection": selection, "result": result })],
            )
            .await?;
    }
    Ok(result)
}

/// `orgtree_staff`: the item (created or updated) and its new owner (hired
/// or rehired) in one call; the assignment mail starts the agent.
#[logged]
pub async fn staff(engine: &Arc<Engine>, org: &Arc<OrgHandle>, me: (i64, &str, i32), args: &Value) -> Result<Value> {
    super::hire_requirements::require_staff(args)?;
    let (my_id, my_name, my_gen) = me;
    let who = Who::Agent { id: my_id, name: my_name.to_string(), generation: my_gen };
    let action = args["action"].as_str().unwrap_or(if args["slug"].as_str().is_some() { "update" } else { "create" });
    let s = |k: &str| args[k].as_str().map(str::trim).filter(|v| !v.is_empty());
    // the docket half is checked before anybody is hired
    match action {
        "create" => {
            if s("title").is_none() {
                refuse!(BadRequest, "a work item needs a title");
            }
            if s("objective").is_none() {
                refuse!(BadRequest, "a work item needs a description in `objective` — the problem first, then the solution");
            }
        }
        "update" => {
            let Some(slug) = s("slug") else { refuse!(BadRequest, "update names the existing item (slug)") };
            docket::agent_get(engine, org, &who, slug, &json!({ "projection": "summary" })).await?;
        }
        other => refuse!(BadRequest, "action is create or update, not {other}"),
    }
    if let Some(st) = s("status") {
        if !["backlogged", "open", "in_progress", "blocked", "review", "deploy_ready"].contains(&st) {
            refuse!(BadRequest, "status is backlogged|open|in_progress|blocked|review|deploy_ready");
        }
    }
    // the seat
    let rehire = s("node").is_some() || s("staff_mode") == Some("rehire");
    let mut req = args.clone();
    req["op"] = json!(if rehire { "rehire" } else { "hire" });
    if let Some(p) = req.as_object_mut() {
        // the item's own fields are not the seat's (`parent` is the parent WORK ITEM, `title` the item's)
        for k in ["parent", "status", "title", "objective", "kind", "participants", "dependencies", "done_so_far",
                  "working_on_next", "slug", "action", "acceptance"] {
            p.remove(k);
        }
    }
    if rehire {
        let Some(node) = s("node") else { refuse!(BadRequest, "rehire names the archived agent (node)") };
        req["node"] = json!(node);
        if let Some(t) = s("target") {
            req["parent"] = json!(t);
        }
    } else {
        if s("hire_type") == Some("superior") {
            req["above"] = s("target").map_or(Value::Null, |t| json!(t));
        } else {
            req["parent"] = json!(s("target").unwrap_or(my_name));
        }
    }
    req["_caller_generation"] = json!(my_gen);
    req["staff_item"] = args.clone();
    let hired = ops::run(engine, org, Actor::Agent { id: my_id, name: my_name.to_string() }, &req).await?;
    let mut out = json!({ "node": hired["node"], "item": hired["item"], "hire": hired,
        "status": "Seat and docket committed together; the assignment mail starts the agent." });
    docket::copy_notice_metadata(&hired, &mut out);
    Ok(out)
}

/// `GET /api/orgs/{slug}/staffing-options`: the warm availability every
/// staffing surface reads (hire modal, staff menus, model/account/effort
/// selects): each tier this machine can staff, its efforts, its eligible
/// accounts, and whether a hire naming no account can run it.
#[logged]
pub fn options(engine: &Engine, org_slug: &str) -> Value {
    let tiers: Vec<Value> = runnable_tiers(engine, org_slug)
        .into_iter()
        .filter_map(|t| {
            let accounts = if accountless(t.provider) { Vec::new() } else { eligible_accounts(engine, &t.tier, org_slug) };
            let host = host_for(engine, org_slug, &t.tier, t.provider)
                && crate::usage::antigravity_limit(engine, &t.tier).is_none()
                && (t.provider != catalog::MUSE || crate::providers::muse_offered(engine, &t.tier));
            if accounts.is_empty() && !host {
                return None;
            }
            Some(json!({ "tier": t.tier, "seat": t.seat, "provider": t.provider, "efforts": t.efforts,
                         "accounts": accounts, "default_ok": host,
                         "native_ok": host && (accountless(t.provider) || crate::usage::at_limit(engine, None, &t.tier).is_none()) }))
        })
        .collect();
    let mut result = availability(engine);
    result["tiers"] = json!(tiers);
    result["generation"] = json!(0);
    result
}

#[logged]
fn availability(engine: &Engine) -> Value {
    let at = Utc::now().timestamp_millis() as f64 / 1000.0;
    let state = engine.providers.state.load();
    let errors: Vec<String> = state.codex_efforts_error.iter()
        .filter(|_| engine.settings.provider_enabled(catalog::OPENAI)).cloned().collect();
    // before the first sign-in check lands, a lane missing from the tiers has
    // not been checked yet: the surfaces say so instead of "not signed in"
    json!({ "at": at, "stale": !errors.is_empty(), "errors": errors, "loading": !state.probed })
}

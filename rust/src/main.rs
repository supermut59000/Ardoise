//! Ardoise server — Rust port of backend/ (FastAPI + MariaDB -> axum + SQLite).
//! Same wire contract (camelCase), same error shapes ({"detail": "..."}),
//! same semantics: append-only op log, idempotent push, pull by cursor.

mod db;
mod pushmod;
mod wire;

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use db::Db;
use futures_util::{Stream, StreamExt};
use pushmod::Config as PushConfig;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use wire::{
    GroupOut, PullResponse, PushRequest, PushResponse, RegisterRequest, SyncRequest,
    SyncResponse, SubscribeRequest, UnsubscribeRequest, VapidPublicOut,
};

/// In-process SSE wake-up fan-out, one broadcast channel per group.
/// Wakes carry only `seq` ("go pull") — the pull is the source of truth, so a
/// missed/lagged wake is harmless: the client's 20 s poll still catches up.
/// Capacity 64: at this scale a subscriber cannot lag 64 wakes behind.
/// ponytail: in-process like the Python event_bus; a real relay network would
/// need a broker (the boxes discussion), not more capacity.
#[derive(Clone, Default)]
struct EventBus {
    channels: Arc<Mutex<HashMap<String, broadcast::Sender<u64>>>>,
}

impl EventBus {
    /// No-op when the group has no live subscribers (the common case: push
    /// with nobody watching).
    fn publish(&self, group_id: &str, seq: u64) {
        if let Some(tx) = self.channels.lock().unwrap().get(group_id) {
            let _ = tx.send(seq); // Err only if all receivers dropped
        }
    }

    fn subscribe(&self, group_id: &str) -> broadcast::Receiver<u64> {
        self.channels
            .lock()
            .unwrap()
            .entry(group_id.to_string())
            .or_insert_with(|| broadcast::channel(64).0)
            .subscribe()
    }
}

#[derive(Clone)]
pub struct Config {
    pub api_key: String,
    pub vapid_private_key: String,
    pub vapid_subject: String,
    pub cors_origins: Vec<String>,
    pub port: u16,
    pub data_file: String,
    pub version: String,
}

#[derive(Clone)]
struct AppState {
    db: Db,
    cfg: Arc<Config>,
    push_cfg: Arc<PushConfig>,
    events: EventBus,
}

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.into())
}

fn load_config() -> Config {
    let cors = env("CORS_ORIGINS", "http://localhost:3060,http://localhost:8065");
    Config {
        api_key: env("API_KEY", ""),
        vapid_private_key: env("VAPID_PRIVATE_KEY", ""),
        vapid_subject: env("VAPID_SUBJECT", "mailto:admin@example.com"),
        cors_origins: cors.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        port: env("PORT", "8001").parse().unwrap_or(8001),
        data_file: env("DATA_FILE", "ardoise.db").into(),
        version: "0.1.0".into(),
    }
}

/// Constant-time compare (length is not hidden — same as secrets.compare_digest).
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc ^ (x ^ y)) == 0
}

fn detail(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "detail": msg.into() }))).into_response()
}

// --- handlers: system ---

async fn root(State(st): State<AppState>) -> Json<Value> {
    Json(json!({ "message": "Ardoise API", "version": st.cfg.version }))
}

/// 503 (not a green "unhealthy" 200) so any monitor sees a DB outage as down.
async fn health(State(st): State<AppState>) -> Response {
    if st.db.health().await {
        Json(json!({ "status": "healthy", "commits": crate::db::Db::commit_count() }))
            .into_response()
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "status": "unhealthy", "db": "unreachable" }))).into_response()
    }
}

async fn ping() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

/// Shared instance password gate (X-API-Key). No-op when API_KEY is unset.
async fn require_api_key(st: &AppState, headers: axum::http::HeaderMap) -> Result<(), Response> {
    if st.cfg.api_key.is_empty() {
        return Ok(());
    }
    let given = headers.get("x-api-key").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !ct_eq(given, &st.cfg.api_key) {
        return Err(detail(StatusCode::UNAUTHORIZED, "Mot de passe du serveur invalide"));
    }
    Ok(())
}

/// auth-check: the client confirms its key once before storing it. The
/// X-API-Key middleware on this route already rejected bad keys (401).
async fn auth_check() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

// --- handlers: groups ---

async fn group_out(st: &AppState, g: &db::Group) -> Result<Json<GroupOut>, Response> {
    let gen = st.db.server_generation().await.map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(GroupOut {
        group_id: g.id.clone(),
        share_code: g.share_code.clone(),
        server_generation: gen,
    }))
}

/// Register a local group for sharing; idempotent (same share code).
async fn register_group(
    State(st): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> Result<Json<GroupOut>, Response> {
    if !(1..=36).contains(&body.group_id.chars().count()) {
        return Err(detail(StatusCode::UNPROCESSABLE_ENTITY, "groupId: 1..=36 chars"));
    }
    let g = st
        .db
        .register_group(&body.group_id)
        .await
        .map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    group_out(&st, &g).await
}

/// Resolve a share code (case-insensitive) so another device can join.
async fn resolve_code(
    State(st): State<AppState>,
    Path(share_code): Path<String>,
) -> Result<Json<GroupOut>, Response> {
    match st.db.resolve_code(&share_code).await.map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))? {
        Some(g) => group_out(&st, &g).await,
        None => Err(detail(StatusCode::NOT_FOUND, "Code de partage introuvable")),
    }
}

async fn get_group(
    State(st): State<AppState>,
    Path(group_id): Path<String>,
) -> Result<Json<GroupOut>, Response> {
    match st.db.get_group(&group_id).await.map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))? {
        Some(g) => group_out(&st, &g).await,
        None => Err(detail(StatusCode::NOT_FOUND, "Groupe non enregistre")),
    }
}

// --- handlers: sync ---

/// Push ops: idempotent append (dedup by op_id). Fan out notifications AFTER
/// the response, only for genuinely new live-sized batches, never for reseed.
async fn push_ops(
    State(st): State<AppState>,
    Path(group_id): Path<String>,
    Json(body): Json<PushRequest>,
) -> Result<Json<PushResponse>, Response> {
    if st.db.get_group(&group_id).await.map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?.is_none() {
        return Err(detail(StatusCode::NOT_FOUND, "Groupe non enregistre"));
    }
    for o in &body.ops {
        if let Err(msg) = o.validate() {
            return Err(detail(StatusCode::UNPROCESSABLE_ENTITY, msg));
        }
    }
    let (accepted, cursor) = st
        .db
        .push_ops(&group_id, &body.ops)
        .await
        .map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let n_accepted = accepted.len() as i64;
    if !accepted.is_empty() && accepted.len() <= pushmod::NOTIFY_MAX_BATCH && !body.reseed && pushmod::push_enabled(&st.push_cfg) {
        let actors: std::collections::HashSet<String> = accepted.iter().map(|o| o.actor.clone()).collect();
        let db = st.db.clone();
        let cfg = st.push_cfg.clone();
        let gid = group_id.clone();
        tokio::spawn(async move {
            pushmod::notify_group(db, cfg, &gid, actors, accepted).await;
        });
    }
    // SSE wake-up: genuinely new ops only (dedup and reseed pushes create no
    // new rows, so other devices have nothing to sync).
    if n_accepted > 0 && !body.reseed {
        st.events.publish(&group_id, cursor as u64);
    }
    Ok(Json(PushResponse { accepted: n_accepted, cursor }))
}

/// Push + pull in ONE round trip: applies `ops` with the exact push semantics
/// (idempotent dedup by opId, same 404 for an unregistered group, same
/// notification fan-out rules), then returns everything with seq > `since` —
/// including the ops just accepted, so the device learns the seq of its own
/// ops without a second request.
async fn sync_ops(
    State(st): State<AppState>,
    Path(group_id): Path<String>,
    Json(body): Json<SyncRequest>,
) -> Result<Json<SyncResponse>, Response> {
    if body.since < 0 {
        return Err(detail(StatusCode::UNPROCESSABLE_ENTITY, "since: >= 0"));
    }
    if st.db.get_group(&group_id).await.map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?.is_none() {
        return Err(detail(StatusCode::NOT_FOUND, "Groupe non enregistre"));
    }
    for o in &body.ops {
        if let Err(msg) = o.validate() {
            return Err(detail(StatusCode::UNPROCESSABLE_ENTITY, msg));
        }
    }
    let (accepted, rows, cursor) = st
        .db
        .sync_ops(&group_id, &body.ops, body.since)
        .await
        .map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let n_accepted = accepted.len() as i64;
    if !accepted.is_empty() && accepted.len() <= pushmod::NOTIFY_MAX_BATCH && !body.reseed && pushmod::push_enabled(&st.push_cfg) {
        let actors: std::collections::HashSet<String> = accepted.iter().map(|o| o.actor.clone()).collect();
        let db = st.db.clone();
        let cfg = st.push_cfg.clone();
        let gid = group_id.clone();
        tokio::spawn(async move {
            pushmod::notify_group(db, cfg, &gid, actors, accepted).await;
        });
    }
    if n_accepted > 0 && !body.reseed {
        st.events.publish(&group_id, cursor as u64);
    }
    let gen = st.db.server_generation().await.map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(SyncResponse {
        accepted: n_accepted,
        ops: rows.into_iter().map(|o| o.to_out()).collect(),
        cursor,
        server_generation: gen,
    }))
}

/// One SSE subscription: owns its broadcast receiver across `unfold`
/// iterations (the async block's state machine keeps the pending `recv()`
/// alive, so waker registration survives — a fresh `recv()` per poll would be
/// unregistered by `Recv::drop` and the wake-up would be lost).
struct Wake {
    rx: broadcast::Receiver<u64>,
    first: bool,
}

/// SSE wake stream for a group: `event: op` + `data: {"seq": N}` whenever new
/// rows land — a wake-up, not data (the client pulls). 15 s keepalive comment
/// like the Python endpoint. The stream never ends server-side; the client
/// closing it drops the receiver.
async fn group_events(
    State(st): State<AppState>,
    Path(group_id): Path<String>,
) -> Response {
    let known = match st.db.get_group(&group_id).await {
        Ok(g) => g.is_some(),
        Err(e) => return detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if !known {
        return detail(StatusCode::NOT_FOUND, "Groupe non enregistre");
    }
    let rx = st.events.subscribe(&group_id);
    let stream = futures_util::stream::unfold(Wake { rx, first: true }, |mut w| async move {
        if w.first {
            w.first = false;
            return Some((Ok::<_, Infallible>(Event::default().comment("connected")), w));
        }
        match w.rx.recv().await {
            Ok(seq) => Some((
                Ok(Event::default().event("op").data(format!("{{\"seq\":{seq}}}"))),
                w,
            )),
            // Lagged (subscriber fell >64 wakes behind): comment no-op for the
            // client; its next wake or 20 s poll re-syncs. Closed is
            // unreachable — senders live as long as the process.
            Err(broadcast::error::RecvError::Lagged(_)) => Some((Ok(Event::default().comment("lagged")), w)),
            Err(broadcast::error::RecvError::Closed) => None,
        }
    });
    sse_response(stream)
}

/// Shared SSE response shape for both wake streams: 15 s keep-alive comment +
/// the headers nginx and the parity matrix check. Sse::into_response sets
/// Cache-Control: no-cache; axum 0.8 removed tuple IntoResponse, so the rest
/// goes through the builder. Starlette emits "text/event-stream; charset=utf-8"
/// — match it for A/B parity.
fn sse_response<S>(stream: S) -> Response
where
    S: futures_util::Stream<Item = Result<Event, Infallible>> + Send + 'static,
{
    let sse = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text("keepalive"));
    let mut resp = sse.into_response();
    resp.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream; charset=utf-8"));
    resp.headers_mut()
        .insert(HeaderName::from_static("x-accel-buffering"), HeaderValue::from_static("no"));
    resp
}

/// One SSE wake-up stream for ALL of a user's groups: the connection-saving
/// endpoint (a user in G groups opens 1 stream instead of G). Frame:
/// `event: op` + `data: {"group":"<id>","seq":N}` — same wake-up semantics as
/// the per-group stream, plus which group fired. Rust-only: the Python
/// backend has no equivalent (documented divergence, context/07); the frontend
/// falls back to per-group streams on 404.
const MAX_STREAM_GROUPS: usize = 50; // ponytail: abuse cap, not a product limit

#[derive(Deserialize)]
struct MultiGroups {
    groups: Option<String>,
}

struct MultiWake {
    rx: tokio::sync::mpsc::Receiver<(String, u64)>,
    first: bool,
}

async fn user_events(State(st): State<AppState>, Query(q): Query<MultiGroups>) -> Response {
    // Dedupe, keep order.
    let mut ids: Vec<String> = Vec::new();
    for s in q.groups.as_deref().unwrap_or_default().split(',') {
        let s = s.trim();
        if !s.is_empty() && !ids.iter().any(|x| x == s) {
            ids.push(s.to_string());
        }
    }
    if ids.is_empty() {
        return detail(StatusCode::BAD_REQUEST, "paramètre 'groups' vide");
    }
    if ids.len() > MAX_STREAM_GROUPS {
        return detail(StatusCode::BAD_REQUEST, format!("max {MAX_STREAM_GROUPS} groupes par stream"));
    }
    // Unknown ids are skipped (a stale local subscription must not kill the
    // stream); nothing known = 404, like the per-group endpoint.
    let mut known: Vec<String> = Vec::new();
    for id in &ids {
        match st.db.get_group(id).await {
            Ok(Some(_)) => known.push(id.clone()),
            Ok(None) => {}
            Err(e) => return detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    }
    if known.is_empty() {
        return detail(StatusCode::NOT_FOUND, "Groupe non enregistre");
    }
    // One forwarder task per connection (not per group): it multiplexes the
    // G broadcast receivers and pushes wakes into a single mpsc that the SSE
    // body reads. Capacity 1: a wake carries no data, at most one pending
    // wake matters, the rest coalesce (the 20 s poll is the truth). The
    // forwarder exits when its send errors, i.e. when the client dropped the
    // stream, so no task outlives the connection.
    let (tx, rx) = tokio::sync::mpsc::channel::<(String, u64)>(1);
    // Pin<Box<dyn Stream>>: select_all requires Unpin streams, and the
    // unfold below is not Unpin (the broadcast Receiver is not).
    let mut streams: Vec<std::pin::Pin<Box<dyn Stream<Item = (String, u64)> + Send>>> =
        Vec::new();
    for gid in known {
        let wrx = st.events.subscribe(&gid);
        // unfold, not poll_fn: the recv() future must stay alive across polls
        // or the waker registration is lost and publishes no longer wake it.
        // The receiver is passed by value and handed back as next state.
        // The (receiver, group name) pair is the unfold state: the closure
        // captures nothing, so each per-item future owns everything it uses.
        let s = futures_util::stream::unfold((wrx, gid), |(mut rx, name)| async move {
            loop {
                match rx.recv().await {
                    Ok(seq) => return Some(((name.clone(), seq), (rx, name))),
                    // Lagged (>64 wakes behind): drop this one wake and wait
                    // for the next; the client's next wake or 20 s poll
                    // re-syncs, same as the per-group stream.
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    // Closed: that group's channel went away; end this stream.
                    // select_all keeps running on the remaining groups, like
                    // the old per-group forwarders.
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        });
        streams.push(Box::pin(s));
    }
    tokio::spawn(async move {
        let mut sel = futures_util::stream::select_all(streams);
        while let Some((name, seq)) = sel.next().await {
            if tx.send((name, seq)).await.is_err() {
                return;
            }
        }
    });
    let stream = futures_util::stream::unfold(MultiWake { rx, first: true }, |mut w| async move {
        if w.first {
            w.first = false;
            return Some((Ok::<_, Infallible>(Event::default().comment("connected")), w));
        }
        match w.rx.recv().await {
            Some((group, seq)) => Some((
                Ok(Event::default()
                    .event("op")
                    .data(serde_json::json!({ "group": group, "seq": seq }).to_string())),
                w,
            )),
            None => None,
        }
    });
    sse_response(stream)
}

#[derive(Deserialize)]
struct PullQuery {
    #[serde(default)]
    since: i64,
}

/// Pull ops with seq > since, in seq order.
async fn pull_ops(
    State(st): State<AppState>,
    Path(group_id): Path<String>,
    Query(q): Query<PullQuery>,
) -> Result<Json<PullResponse>, Response> {
    if q.since < 0 {
        return Err(detail(StatusCode::UNPROCESSABLE_ENTITY, "since: >= 0"));
    }
    if st.db.get_group(&group_id).await.map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?.is_none() {
        return Err(detail(StatusCode::NOT_FOUND, "Groupe non enregistre"));
    }
    let (rows, cursor) = st
        .db
        .pull_ops(&group_id, q.since)
        .await
        .map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let gen = st.db.server_generation().await.map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(PullResponse {
        ops: rows.into_iter().map(|o| o.to_out()).collect(),
        cursor,
        server_generation: gen,
    }))
}

// --- handlers: push subscriptions ---

fn require_push_enabled(cfg: &Config) -> Result<(), Response> {
    if cfg.vapid_private_key.is_empty() {
        return Err(detail(StatusCode::SERVICE_UNAVAILABLE, "Notifications non configurees sur ce serveur"));
    }
    Ok(())
}

/// The applicationServerKey the browser needs to subscribe.
async fn vapid_public_key(State(st): State<AppState>) -> Result<Json<VapidPublicOut>, Response> {
    require_push_enabled(&st.cfg)?;
    match st.push_cfg.vapid_public_key() {
        Some(k) => Ok(Json(VapidPublicOut { public_key: k })),
        None => Err(detail(StatusCode::INTERNAL_SERVER_ERROR, "VAPID_PRIVATE_KEY mal formee")),
    }
}

/// Upsert keyed by endpoint; the client re-sends whenever its group list changes.
async fn subscribe(
    State(st): State<AppState>,
    Json(body): Json<SubscribeRequest>,
) -> Result<Json<Value>, Response> {
    require_push_enabled(&st.cfg)?;
    if let Err(msg) = wire::validate_endpoint(&body.endpoint) {
        return Err(detail(StatusCode::UNPROCESSABLE_ENTITY, msg));
    }
    if body.device_id.chars().count() > 64 {
        return Err(detail(StatusCode::UNPROCESSABLE_ENTITY, "deviceId: <=64 chars"));
    }
    st.db
        .upsert_sub(&db::Sub {
            endpoint: body.endpoint,
            p256dh: body.keys.p256dh,
            auth: body.keys.auth,
            device_id: body.device_id,
            group_ids: body.group_ids,
        })
        .await
        .map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

/// Idempotent: unknown endpoints are a no-op.
async fn unsubscribe(
    State(st): State<AppState>,
    Json(body): Json<UnsubscribeRequest>,
) -> Result<Json<Value>, Response> {
    require_push_enabled(&st.cfg)?;
    let _ = st.db.delete_sub(&body.endpoint).await; // errors are a no-op, like Python's missing-row case
    Ok(Json(json!({ "ok": true })))
}

/// Test-only hook: `ardoise ece-cross <input.json> <out.bin> <out.jwt> <out.pub>`.
/// Encrypts input.payload for the input's subscription (keys in the JSON) so the
/// Python reference (pywebpush/http_ece) can decrypt it: cross-language
/// conformance check of the RFC 8291 aes128gcm wire format.
fn ece_cross(args: &[String]) -> ! {
    let (input, out_bin, out_jwt, out_pub) = match (args.get(2), args.get(3), args.get(4), args.get(5)) {
        (Some(a), Some(b), Some(c), Some(d)) => (a, b, c, d),
        _ => {
            eprintln!("usage: ardoise ece-cross <input.json> <out.bin> <out.jwt> <out.pub>");
            std::process::exit(2);
        }
    };
    let v: serde_json::Value = std::fs::read_to_string(input)
        .expect("lecture input.json")
        .parse()
        .expect("parse input.json");
    let get = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or(k).to_string();
    let cfg = PushConfig { vapid_private_key: get("vapid_private_key"), vapid_subject: get("vapid_subject") };
    let secret = pushmod::vapid_secret(&cfg).expect("clé VAPID invalide");
    let sub = db::Sub {
        endpoint: get("endpoint"),
        p256dh: get("p256dh"),
        auth: get("auth"),
        device_id: "cross".into(),
        group_ids: vec![],
    };
    let wire = pushmod::encrypt_ecce_aes128gcm(&sub, &get("payload")).expect("chiffrement ECE");
    let jwt = pushmod::vapid_jwt(&cfg, &secret, &sub.endpoint).expect("JWT VAPID");
    std::fs::write(out_bin, &wire).expect("écriture out.bin");
    std::fs::write(out_jwt, jwt).expect("écriture out.jwt");
    std::fs::write(out_pub, pushmod::vapid_public_key_bytes(&secret)).expect("écriture out.pub");
    println!("wire: {} octets", wire.len());
    std::process::exit(0);
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("ece-cross") {
        ece_cross(&args);
    }
    let cfg = load_config();
    let db = db::open(&cfg.data_file).expect("failed to open database");
    let state = AppState {
        db,
        cfg: Arc::new(cfg.clone()),
        push_cfg: Arc::new(PushConfig {
            vapid_private_key: cfg.vapid_private_key.clone(),
            vapid_subject: cfg.vapid_subject.clone(),
        }),
        events: EventBus::default(),
    };

    let app = build_app(state);

    let addr = format!("0.0.0.0:{}", cfg.port);
    println!("ardoise listening on {addr} (db: {})", cfg.data_file);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await.expect("failed to bind");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            println!("shutting down");
        })
        .await
        .expect("server error");
}

fn build_app(state: AppState) -> Router {
    let cfg = state.cfg.clone();
    // Configured list = the allowed set; empty = local dev, allow anything.
    let cors = if cfg.cors_origins.is_empty() {
        CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any)
            // No allow_credentials: tower-http 0.6 asserts it cannot combine
            // with wildcard methods/headers (panics on poll_ready, e.g. via
            // tower::ServiceExt::oneshot), and the client uses X-API-Key — no
            // cookie-credentialed CORS in dev.
            // ponytail: if cookie auth ever appears, switch dev mode to an
            // explicit allow_headers list like the configured branch.
    } else {
        use axum::http::HeaderValue;
        let origins: Vec<HeaderValue> = cfg
            .cors_origins
            .iter()
            .filter_map(|o| HeaderValue::from_str(o).ok())
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS])
            .allow_headers([
                header::CONTENT_TYPE,
                header::AUTHORIZATION,
                axum::http::HeaderName::from_static("x-api-key"),
                header::ACCEPT,
            ])
            .allow_credentials(true)
    };

    // /system/ping is public (monitoring probe); everything else under
    // /api/v1 is gated, mirroring api_router's dependencies in v1/api.py.
    let authed = Router::new()
        .route("/system/auth-check", get(auth_check))
        .route("/groups/register", post(register_group))
        .route("/groups/resolve/{share_code}", get(resolve_code))
        .route("/groups/{group_id}", get(get_group))
        .route("/groups/{group_id}/ops", post(push_ops).get(pull_ops))
        .route("/groups/{group_id}/sync", post(sync_ops))
        .route("/groups/events", get(user_events))
        .route("/groups/{group_id}/events", get(group_events))
        .route("/push/vapid-public-key", get(vapid_public_key))
        .route("/push/subscribe", post(subscribe))
        .route("/push/unsubscribe", post(unsubscribe))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            |State(st), req: axum::extract::Request, next: axum::middleware::Next| async move {
                let headers = req.headers().clone();
                require_api_key(&st, headers).await?;
                Ok::<_, Response>(next.run(req).await)
            },
        ));

    let api = Router::new().route("/system/ping", get(ping)).merge(authed);

    Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .nest("/api/v1", api)
        .layer(cors)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt; // oneshot: consume a Router without binding a port

    fn test_state(tag: &str) -> AppState {
        let p = format!("/tmp/ardoise-maintest-{}-{}.db", std::process::id(), tag);
        let _ = std::fs::remove_file(&p);
        AppState {
            db: db::open(&p).unwrap(),
            cfg: Arc::new(Config {
                api_key: String::new(),
                vapid_private_key: String::new(),
                vapid_subject: "mailto:t@example.com".into(),
                cors_origins: vec![],
                port: 0,
                data_file: p,
                version: "t".into(),
            }),
            push_cfg: Arc::new(PushConfig {
                vapid_private_key: String::new(),
                vapid_subject: "mailto:t@example.com".into(),
            }),
            events: EventBus::default(),
        }
    }

    async fn register(app: &Router, gid: &str) -> StatusCode {
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/groups/register")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&json!({ "groupId": gid })).unwrap()))
            .unwrap();
        app.clone().oneshot(req).await.unwrap().status()
    }

    fn op_json_for(op_id: &str, group: &str) -> Value {
        json!({
            "opId": op_id, "groupId": group, "entity": "expense", "entityId": "e1",
            "action": "create", "payload": {"amountCents": 5}, "actor": "dev",
            "lamport": 1, "createdAt": 1,
        })
    }

    fn op_json(op_id: &str) -> Value {
        op_json_for(op_id, "g1")
    }

    fn sync_req_to(group: &str, body: Value) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(format!("/api/v1/groups/{group}/sync"))
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&body).unwrap()))
            .unwrap()
    }

    fn sync_req(body: Value) -> Request<Body> {
        sync_req_to("g1", body)
    }

    #[tokio::test]
    async fn sync_endpoint_returns_own_ops_in_one_round_trip() {
        let app = build_app(test_state("sync"));
        assert_eq!(register(&app, "g1").await, StatusCode::OK);
        let res = app.clone().oneshot(sync_req(json!({ "ops": [op_json("o1")], "since": 0 }))).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let v: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap();
        assert_eq!(v["accepted"], 1);
        assert_eq!(v["cursor"], 1);
        assert_eq!(v["ops"][0]["opId"], "o1");
        assert!(v["serverGeneration"].is_string());
        // Re-sync the same op: nothing accepted, empty window (since=1).
        let res = app.clone().oneshot(sync_req(json!({ "ops": [op_json("o1")], "since": 1 }))).await.unwrap();
        let v: Value = serde_json::from_slice(&axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap().to_vec()).unwrap();
        assert_eq!(v["accepted"], 0);
        assert_eq!(v["cursor"], 1);
        assert_eq!(v["ops"].as_array().unwrap().len(), 0);
        // Unregistered group: 404 like /ops.
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/groups/ghost/sync")
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_string(&json!({ "ops": [], "since": 0 })).unwrap()))
            .unwrap();
        assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::NOT_FOUND);
        // since < 0: clean 422, never a 500.
        let res = app.clone().oneshot(sync_req(json!({ "ops": [], "since": -1 }))).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn events_endpoint_serves_sse_for_registered_group() {
        let app = build_app(test_state("events"));
        assert_eq!(register(&app, "g1").await, StatusCode::OK);
        let req = Request::builder().uri("/api/v1/groups/g1/events").body(Body::empty()).unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(res.headers()[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/event-stream"));
        assert_eq!(res.headers().get(header::CACHE_CONTROL).unwrap(), "no-cache");
        assert_eq!(res.headers().get(HeaderName::from_static("x-accel-buffering")).unwrap(), "no");
        // Body is an infinite stream: header check only; dropping the
        // response drops the receiver.
        // Unregistered group: 404, never a stream.
        let req = Request::builder().uri("/api/v1/groups/ghost/events").body(Body::empty()).unwrap();
        assert_eq!(app.oneshot(req).await.unwrap().status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn multi_events_one_stream_and_error_paths() {
        let app = build_app(test_state("multi"));
        assert_eq!(register(&app, "g1").await, StatusCode::OK);
        assert_eq!(register(&app, "g2").await, StatusCode::OK);
        // Dedupe + unknown ids are skipped: g1 appears twice, ghost is not
        // registered — the stream still opens for the two known groups.
        let req = Request::builder()
            .uri("/api/v1/groups/events?groups=g1,g2,ghost,g1%20")
            .body(Body::empty())
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(res.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream"));
        // Body is an infinite stream: header check only; dropping the response
        // drops the receivers and the forwarder tasks.
        // Unknown-only list: 404. Empty list: 400.
        let req = Request::builder().uri("/api/v1/groups/events?groups=ghost").body(Body::empty()).unwrap();
        assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::NOT_FOUND);
        let req = Request::builder().uri("/api/v1/groups/events?groups=,,").body(Body::empty()).unwrap();
        assert_eq!(app.oneshot(req).await.unwrap().status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn multi_events_wake_names_its_group() {
        use futures_util::StreamExt;
        let app = build_app(test_state("multiwake"));
        assert_eq!(register(&app, "g1").await, StatusCode::OK);
        assert_eq!(register(&app, "g2").await, StatusCode::OK);
        let req = Request::builder()
            .uri("/api/v1/groups/events?groups=g1,g2")
            .body(Body::empty())
            .unwrap();
        let res = app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let mut stream = res.into_body().into_data_stream();
        // A push to g2 must wake the stream naming g2 — and g1 must stay quiet.
        let res = app
            .clone()
            .oneshot(sync_req_to("g2", json!({ "ops": [op_json_for("w1", "g2")], "since": 0 })))
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let mut buf = String::new();
        let deadline = tokio::time::sleep(Duration::from_secs(2));
        tokio::pin!(deadline);
        loop {
            if buf.contains("\"group\":\"g2\"") {
                break;
            }
            tokio::select! {
                _ = &mut deadline => panic!("no g2 wake within 2s; got: {buf}"),
                Some(chunk) = stream.next() => buf.push_str(&String::from_utf8_lossy(&chunk.expect("stream ended"))),
            }
        }
        assert!(!buf.contains("\"group\":\"g1\""), "g1 must not be woken by a g2 push");
    }

    #[tokio::test]
    async fn event_bus_wakes_subscriber_and_noops_without() {
        let bus = EventBus::default();
        let mut rx = bus.subscribe("g1");
        bus.publish("g1", 42);
        let v = tokio::time::timeout(Duration::from_secs(1), rx.recv()).await.unwrap().unwrap();
        assert_eq!(v, 42);
        bus.publish("ghost", 1); // no subscribers: no-op, no panic
    }
}

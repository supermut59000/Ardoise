//! Ardoise server — Rust port of backend/ (FastAPI + MariaDB -> axum + SQLite).
//! Same wire contract (camelCase), same error shapes ({"detail": "..."}),
//! same semantics: append-only op log, idempotent push, pull by cursor.

mod db;
mod pushmod;
mod wire;

use axum::extract::{Path, Query, State};
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use db::Db;
use pushmod::Config as PushConfig;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use wire::{
    GroupOut, PullResponse, PushRequest, PushResponse, RegisterRequest,
    SubscribeRequest, UnsubscribeRequest, VapidPublicOut,
};

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
    if st.db.health() {
        Json(json!({ "status": "healthy" })).into_response()
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

fn group_out(st: &AppState, g: &db::Group) -> Result<Json<GroupOut>, Response> {
    let gen = st.db.server_generation().map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
        .map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    group_out(&st, &g)
}

/// Resolve a share code (case-insensitive) so another device can join.
async fn resolve_code(
    State(st): State<AppState>,
    Path(share_code): Path<String>,
) -> Result<Json<GroupOut>, Response> {
    match st.db.resolve_code(&share_code).map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))? {
        Some(g) => group_out(&st, &g),
        None => Err(detail(StatusCode::NOT_FOUND, "Code de partage introuvable")),
    }
}

async fn get_group(
    State(st): State<AppState>,
    Path(group_id): Path<String>,
) -> Result<Json<GroupOut>, Response> {
    match st.db.get_group(&group_id).map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))? {
        Some(g) => group_out(&st, &g),
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
    if st.db.get_group(&group_id).map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?.is_none() {
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
    Ok(Json(PushResponse { accepted: n_accepted, cursor }))
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
    if st.db.get_group(&group_id).map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?.is_none() {
        return Err(detail(StatusCode::NOT_FOUND, "Groupe non enregistre"));
    }
    let (rows, cursor) = st
        .db
        .pull_ops(&group_id, q.since)
        .map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let gen = st.db.server_generation().map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
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
        .map_err(|e| detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(json!({ "ok": true })))
}

/// Idempotent: unknown endpoints are a no-op.
async fn unsubscribe(
    State(st): State<AppState>,
    Json(body): Json<UnsubscribeRequest>,
) -> Result<Json<Value>, Response> {
    require_push_enabled(&st.cfg)?;
    let _ = st.db.delete_sub(&body.endpoint); // errors are a no-op, like Python's missing-row case
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
    };

    // Configured list = the allowed set; empty = local dev, allow anything.
    let cors = if cfg.cors_origins.is_empty() {
        CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any).allow_credentials(true)
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

    let app = Router::new()
        .route("/", get(root))
        .route("/health", get(health))
        .nest("/api/v1", api)
        .layer(cors)
        .with_state(state.clone());

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

//! Web Push fan-out. Message building ported from backend/app/services/push_service.py:
//! messages are built from op payloads alone (the server never folds state).
//!
//! Sender: RFC 8291 "aes128gcm" (ECE) + RFC 8292 (VAPID JWT, ES256), byte-for-
//! byte the pywebpush/py_vapid wire protocol: ephemeral P-256 ECDH key per
//! message, salt/rs/keyid header, two-stage HKDF (RFC 8188), no AAD, TTL 3600,
//! 5 s timeout, 404/410 prune the subscription.

use crate::db::{Db, Sub};
use crate::wire::OperationWire;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Key, Nonce};
use base64::Engine;
use hkdf::Hkdf;
use p256::elliptic_curve::generic_array::GenericArray;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::ecdsa::signature::Signer;
use p256::elliptic_curve::ecdh::diffie_hellman;
use p256::{SecretKey as P256Secret, PublicKey};
use rand::RngCore;
use serde_json::Value;
use sha2::Sha256;
use std::sync::Arc;
use std::time::Duration;

/// Above this many newly-accepted ops the push is a reseed/catch-up, not live
/// activity: stay silent (a "300 modifications" ping confuses people).
pub const NOTIFY_MAX_BATCH: usize = 50;

pub struct Config {
    pub vapid_private_key: String,
    pub vapid_subject: String,
}

/// Push works only if the key parses as a P-256 scalar; a garbage key can
/// never sign, so fan-out stays off (endpoints keep their own check).
pub fn push_enabled(cfg: &Config) -> bool {
    vapid_secret(cfg).is_some()
}

/// Base64url engine shared by every key exchange in this module. Decode is
/// padding-indifferent: web push keys in the wild are unpadded.
fn b64url() -> base64::engine::GeneralPurpose {
    base64::engine::GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        base64::engine::GeneralPurposeConfig::new()
            .with_encode_padding(false)
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    )
}

/// Random P-256 scalar (p256 0.13 exposes no `rand` feature; rejection loop
/// over the ~2^-128 invalid range).
fn random_p256() -> p256::SecretKey {
    let mut bytes = [0u8; 32];
    loop {
        rand::thread_rng().fill_bytes(&mut bytes);
        if let Ok(sk) = p256::SecretKey::from_bytes(&GenericArray::clone_from_slice(&bytes)) {
            return sk;
        }
    }
}

/// Decoded VAPID secret key (the py_vapid "raw" format: base64url 32-byte
/// P-256 scalar), parsed once.
pub(crate) fn vapid_secret(cfg: &Config) -> Option<P256Secret> {
    let scalar = b64url().decode(cfg.vapid_private_key.trim()).ok()?;
    if scalar.len() != 32 {
        return None;
    }
    P256Secret::from_bytes(&GenericArray::clone_from_slice(&scalar)).ok()
}

impl Config {
    /// py_vapid "raw" format: base64url of the 32-byte P-256 scalar. Derive
    /// the base64url uncompressed-point public key (the browser's
    /// applicationServerKey) exactly like the Python version.
    pub fn vapid_public_key(&self) -> Option<String> {
        let pk = vapid_secret(self)?.public_key();
        Some(b64url().encode(pk.to_encoded_point(false).as_bytes()))
    }

}

/// Raw VAPID public key (uncompressed P-256 point, 65 bytes).
pub fn vapid_public_key_bytes(secret: &P256Secret) -> Vec<u8> {
    secret.public_key().to_encoded_point(false).as_bytes().to_vec()
}

/// scheme://host[:port] of the push endpoint (the VAPID `aud` claim).
fn endpoint_origin(endpoint: &str) -> Option<String> {
    let rest = endpoint.split_once("://")?;
    let (scheme, tail) = (rest.0.to_string(), rest.1);
    let hostport = tail.split('/').next()?.to_string();
    if hostport.is_empty() || !hostport.chars().all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c)) {
        return None;
    }
    Some(format!("{scheme}://{hostport}"))
}

/// VAPID JWT (RFC 8292): ES256 over {aud: endpoint origin, exp: now+12h,
/// sub: the configured contact}, base64url segments, raw 64-byte r||S signature.
pub(crate) fn vapid_jwt(cfg: &Config, secret: &P256Secret, endpoint: &str) -> Option<String> {
    let aud = endpoint_origin(endpoint)?;
    let header = b64url().encode(serde_json::json!({"typ":"JWT","alg":"ES256"}).to_string());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let claims = b64url().encode(
        serde_json::json!({"aud": aud, "exp": now + 43200, "sub": cfg.vapid_subject}).to_string(),
    );
    let signing_input = format!("{header}.{claims}");
    let sk = p256::ecdsa::SigningKey::from(secret.clone());
    // ES256 = ECDSA over SHA-256(signing_input). Signer::sign applies the
    // curve digest (SHA-256 for P-256) itself; sign_prehash would treat the
    // raw header.claims bytes as the already-hashed digest (wrong).
    let sig: p256::ecdsa::Signature = sk.sign(signing_input.as_bytes());
    // RFC 7518 §3.4: ES256 signatures must be "low S". ecdsa 0.16 does not
    // normalize, so a ~50% of RFC 6979 `k` values yield a high-S sig that
    // strict verifiers (cryptography, FCM) reject. normalize_s() -> Some
    // only when it actually flipped s, hence unwrap_or(sig).
    let sig = sig.normalize_s().unwrap_or(sig);
    Some(format!("{signing_input}.{}", b64url().encode(sig.to_bytes().as_slice())))
}

/// {cents / 100:.2f} with the French decimal comma, e.g. 4250 -> "42,50 EUR".
fn amount(payload: &Value) -> String {
    // Python: isinstance(cents, (int, float)) — both accepted (42 and 42.5).
    let cents = match payload.get("amountCents").and_then(|v| v.as_f64()) {
        Some(c) => c,
        None => return String::new(),
    };
    let s = format!("{:.2}", cents / 100.0);
    format!("{} EUR", s.replace('.', ","))
}

/// Match Python str() on the realistic range: 42 -> "42", 8.0 -> "8.0".
fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(), // serde_json prints ints without .0, floats ryu-style
    }
}

/// French notification body. Mirrors build_body() in push_service.py.
pub fn build_body(ops: &[OperationWire], lookup: &dyn Fn(&str, Option<&str>, &str) -> Option<String>) -> String {
    if ops.len() == 1 {
        let op = &ops[0];
        let p = &op.payload;
        let known = |field: &str| -> String {
            let v = p
                .get(field)
                .filter(|v| !v.is_null())
                .cloned()
                .or_else(|| lookup(&op.entity, Some(&op.entity_id), field).map(Value::String))
                .unwrap_or(Value::String(String::new()));
            value_to_string(&v).trim().to_string()
        };
        if op.entity == "expense" {
            let desc = known("description");
            return if op.action == "create" {
                let base = if desc.is_empty() { "Nouvelle depense" } else { &format!("Nouvelle depense : {desc}") };
                let amt = amount(p);
                if amt.is_empty() { base.to_string() } else { format!("{base} ({amt})") }
            } else if op.action == "update" {
                if desc.is_empty() { "Depense modifiee".into() } else { format!("Depense modifiee : {desc}") }
            } else {
                if desc.is_empty() { "Depense supprimee".into() } else { format!("Depense supprimee : {desc}") }
            };
        }
        if op.entity == "settlement" {
            return if op.action == "create" {
                let amt = amount(p);
                if amt.is_empty() { "Remboursement enregistre".into() } else { format!("Remboursement enregistre : {amt}") }
            } else {
                "Remboursement annule".into()
            };
        }
        if op.entity == "member" {
            let name = known("name");
            return if op.action == "create" {
                if name.is_empty() { "Nouveau participant".into() } else { format!("Nouveau participant : {name}") }
            } else if op.action == "update" {
                if name.is_empty() { "Participant renomme".into() } else { format!("Participant renomme : {name}") }
            } else {
                if name.is_empty() { "Participant retire".into() } else { format!("Participant retire : {name}") }
            };
        }
        if op.entity == "group" {
            if op.action == "update" {
                if let Some(Value::String(n)) = p.get("name") {
                    return format!("Groupe renomme : {n}");
                }
            }
            if op.action == "delete" {
                return "Groupe supprime".into();
            }
        }
    }
    let n = ops.len();
    format!("{n} modification{}", if n > 1 { "s" } else { "" })
}

/// RFC 8291 "aes128gcm" (ECE), byte-for-byte the http_ece/pywebpush wire
/// protocol: ephemeral P-256 key per message, wire = salt(16) || rs(4, fixed
/// 4096) || keyid_len(1) || keyid(65) || AES-128-GCM(payload + 0x02) with NO
/// AAD; key/nonce via two-stage HKDF-SHA256 (RFC 8188). Returns the wire
/// bytes. The plaintext is the payload as-is: the browser hands it to the
/// service worker verbatim (event.data.json()).
pub(crate) fn encrypt_ecce_aes128gcm(sub: &Sub, payload: &str) -> Result<Vec<u8>, String> {
    const RS: u32 = 4096; // http_ece MAX_RECORD_SIZE
    let b64 = b64url();
    let client_raw = b64.decode(&sub.p256dh).map_err(|_| "p256dh invalide".to_string())?;
    if client_raw.len() != 65 || client_raw[0] != 0x04 {
        return Err("p256dh: point non compressé attendu".into());
    }
    let auth = b64.decode(&sub.auth).map_err(|_| "auth invalide".to_string())?;
    if auth.len() != 16 {
        return Err("auth: 16 octets attendus".into());
    }
    let client_pub = PublicKey::from_sec1_bytes(&client_raw).map_err(|_| "p256dh: point invalide".to_string())?;

    // Ephemeral ECDH key (pywebpush does the same; the VAPID key only signs the JWT).
    let eph = random_p256();
    let eph_pub = eph.public_key().to_encoded_point(false).as_bytes().to_vec();

    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);

    let shared = diffie_hellman(eph.to_nonzero_scalar(), client_pub.as_affine());
    let shared = shared.raw_secret_bytes();

    // Stage 1 (RFC 8291): HKDF(salt=auth, ikm=shared,
    // info="WebPush: info\0"||client_pub||server_pub) -> 32 bytes.
    let mut hkdf_auth = [0u8; 32];
    let mut info1 = Vec::with_capacity(14 + 130);
    info1.extend_from_slice(b"WebPush: info\0");
    info1.extend_from_slice(&client_raw);
    info1.extend_from_slice(&eph_pub);
    Hkdf::<Sha256>::new(Some(&auth), shared)
        .expand(&info1, &mut hkdf_auth)
        .map_err(|e| e.to_string())?;

    // Stage 2 (RFC 8188): HKDF(salt=wire salt, ikm=stage1) -> CEK + base nonce.
    let mut cek = [0u8; 16];
    Hkdf::<Sha256>::new(Some(&salt), &hkdf_auth)
        .expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|e| e.to_string())?;
    let mut nonce = [0u8; 12];
    Hkdf::<Sha256>::new(Some(&salt), &hkdf_auth)
        .expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(86 + payload.len() + 1 + 16);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&RS.to_be_bytes());
    out.push(eph_pub.len() as u8);
    out.extend_from_slice(&eph_pub);

    let mut pt = payload.as_bytes().to_vec();
    pt.push(0x02); // single-record "last record" delimiter (RFC 8291)
    let cipher = Aes128Gcm::new(Key::<Aes128Gcm>::from_slice(&cek));
    let ct = cipher.encrypt(Nonce::from_slice(&nonce), pt.as_slice()).map_err(|e| e.to_string())?;
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Send one notification to one subscription. Returns the push service's HTTP
/// status when it rejected the subscription, None on success, Err on transport
/// failure (subscription kept, retried on the next event).
async fn send_one(
    client: &reqwest::Client,
    cfg: &Config,
    secret: &P256Secret,
    sub: &Sub,
    payload: &str,
) -> Result<Option<u16>, String> {
    let jwt = vapid_jwt(cfg, secret, &sub.endpoint).ok_or("endpoint: pas de VAPID aud")?;
    let body = encrypt_ecce_aes128gcm(sub, payload)?;
    // Headers mirror pywebpush's aes128gcm path exactly: no Crypto-Key (the
    // ephemeral server key travels in the ECE header, and the client already
    // holds its own auth secret), no Topic (the reference sends it not either).
    let resp = client
        .post(&sub.endpoint)
        .header("Authorization", format!("Bearer {jwt}"))
        .header("TTL", "3600")
        .header("Content-Encoding", "aes128gcm")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    if (200..300).contains(&status) {
        Ok(None)
    } else {
        Ok(Some(status))
    }
}


/// Fan out to every subscribed device following `group_id` except the authors.
/// Runs in a spawned task: a slow push service never delays sync. 404/410 prune
/// the subscription (expired/revoked); transport errors keep it (transient).
pub async fn notify_group(
    db: Db,
    cfg: Arc<Config>,
    group_id: &str,
    excluded: std::collections::HashSet<String>,
    ops: Vec<OperationWire>,
) {
    if !push_enabled(&cfg) || ops.is_empty() {
        return;
    }
    let secret = match vapid_secret(&cfg) {
        Some(s) => s,
        None => {
            eprintln!("push: VAPID_PRIVATE_KEY mal formee, fan-out annule");
            return;
        }
    };
    let gid = group_id.to_string();
    // build_body is sync: pre-fetch the latest known fields for this batch
    // (superset: description + name per op, plus the title field); the
    // lookup closure hits the map, not the DB.
    let mut needed: std::collections::HashSet<(String, Option<String>, String)> = std::collections::HashSet::new();
    for op in &ops {
        needed.insert((op.entity.clone(), Some(op.entity_id.clone()), "description".into()));
        needed.insert((op.entity.clone(), Some(op.entity_id.clone()), "name".into()));
    }
    needed.insert(("group".into(), None, "name".into()));
    let mut latest: std::collections::HashMap<(String, Option<String>, String), Option<String>> = std::collections::HashMap::new();
    for (e, id, f) in &needed {
        latest.insert((e.clone(), id.clone(), f.clone()), db.latest_field(&gid, e, f, id.as_deref()).await.ok().flatten());
    }
    let lookup = |entity: &str, entity_id: Option<&str>, field: &str| -> Option<String> {
        latest.get(&(entity.to_string(), entity_id.map(String::from), field.to_string())).cloned().flatten()
    };
    let title = lookup("group", None, "name").unwrap_or_else(|| "Ardoise".into());
    let body = build_body(&ops, &lookup);
    let payload = serde_json::json!({"title": title, "body": body, "groupId": gid}).to_string();

    let subs = match db.list_subs().await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("push: lecture des abonnements impossible: {e}");
            return;
        }
    };
    // Friends-scale table: filter in memory rather than JSON-querying the DB.
    let targets: Vec<&Sub> = subs
        .iter()
        .filter(|s| !excluded.contains(&s.device_id) && s.group_ids.contains(&gid))
        .collect();

    // 5 s timeout: a "hold" endpoint must not park the task forever (red-team F10).
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_default();
    for sub in targets {
        match send_one(&client, &cfg, &secret, sub, &payload).await {
            Ok(None) => {}
            Ok(Some(status)) => {
                if status == 404 || status == 410 {
                    if let Err(e) = db.delete_sub(&sub.endpoint).await {
                        let ep = &sub.endpoint[..sub.endpoint.len().min(60)];
                        eprintln!("push: suppression de {ep} impossible: {e}");
                    }
                } else {
                    eprintln!("push: echec ({status}) pour {}", &sub.endpoint[..sub.endpoint.len().min(60)]);
                }
            }
            Err(e) => eprintln!("push: transport: {e} pour {}", &sub.endpoint[..sub.endpoint.len().min(60)]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn op(entity: &str, action: &str, payload: Value) -> OperationWire {
        OperationWire {
            op_id: "a".into(),
            group_id: "g".into(),
            entity: entity.into(),
            entity_id: "e".into(),
            action: action.into(),
            payload,
            actor: "x".into(),
            lamport: 1,
            created_at: 1,
        }
    }
    fn no_lookup(_e: &str, _id: Option<&str>, _f: &str) -> Option<String> {
        None
    }

    #[test]
    fn messages_match_python() {
        assert_eq!(
            build_body(&[op("expense", "create", json!({"description": "Pizza", "amountCents": 4250}))], &no_lookup),
            "Nouvelle depense : Pizza (42,50 EUR)"
        );
        assert_eq!(
            build_body(&[op("expense", "delete", json!({}))], &|_e, _i, f| if f == "description" { Some("Pizza".into()) } else { None }),
            "Depense supprimee : Pizza"
        );
        assert_eq!(build_body(&[op("expense", "update", json!({}))], &no_lookup), "Depense modifiee");
        assert_eq!(
            build_body(&[op("settlement", "create", json!({"amountCents": 1000}))], &no_lookup),
            "Remboursement enregistre : 10,00 EUR"
        );
        assert_eq!(build_body(&[op("settlement", "delete", json!({}))], &no_lookup), "Remboursement annule");
        assert_eq!(
            build_body(&[op("member", "create", json!({"name": "Alice"}))], &no_lookup),
            "Nouveau participant : Alice"
        );
        assert_eq!(build_body(&[op("member", "delete", json!({}))], &no_lookup), "Participant retire");
        assert_eq!(
            build_body(&[op("group", "update", json!({"name": "Vacances"}))], &no_lookup),
            "Groupe renomme : Vacances"
        );
        assert_eq!(build_body(&[op("group", "delete", json!({}))], &no_lookup), "Groupe supprime");
        // group create / unknown combo -> falls through to the count.
        assert_eq!(build_body(&[op("group", "create", json!({"name": "X"}))], &no_lookup), "1 modification");
        let mut two = vec![op("expense", "create", json!({}))];
        two.push(op("member", "create", json!({})));
        assert_eq!(build_body(&two, &no_lookup), "2 modifications");
    }


    #[test]
    fn vapid_jwt_verifies_as_es256() {
        use p256::ecdsa::signature::Verifier;
        type Sig = p256::ecdsa::Signature;
        type Vk = p256::ecdsa::VerifyingKey;
        // fixed 32-byte scalar, base64url
        let cfg = Config { vapid_private_key: b64url().encode([7u8; 32]), vapid_subject: "mailto:t@x.y".into() };
        let secret = vapid_secret(&cfg).unwrap();
        let jwt = vapid_jwt(&cfg, &secret, "https://fcm.googleapis.com/fcm/send/dev").unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: Value = serde_json::from_str(&String::from_utf8(b64url().decode(parts[0]).unwrap()).unwrap()).unwrap();
        assert_eq!(header["alg"], "ES256");
        let claims: Value = serde_json::from_str(&String::from_utf8(b64url().decode(parts[1]).unwrap()).unwrap()).unwrap();
        assert_eq!(claims["aud"], "https://fcm.googleapis.com");
        assert_eq!(claims["sub"], "mailto:t@x.y");
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        assert!(claims["exp"].as_u64().unwrap() > now + 43000);
        let vk = Vk::from_sec1_bytes(secret.public_key().to_encoded_point(false).as_bytes())
            .expect("verifying key");
        let sig = Sig::from_slice(&b64url().decode(parts[2]).unwrap()).unwrap();
        // ES256: verify over SHA-256(header.claims); Verifier::verify hashes.
        vk.verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig)
            .expect("ES256 signature must verify");
    }

    #[test]
    fn ece_roundtrip_with_independent_client_key() {
        // "Client" (browser) key pair - the only key material a browser holds.
        let client = random_p256();
        let client_pub_bytes = client.public_key().to_encoded_point(false).as_bytes().to_vec();
        let sub = Sub {
            endpoint: "https://push.example/x".into(),
            p256dh: b64url().encode(&client_pub_bytes),
            auth: b64url().encode([3u8; 16]),
            device_id: "d1".into(),
            group_ids: vec!["g".into()],
        };
        let payload = "hello ardoise";
        let wire = encrypt_ecce_aes128gcm(&sub, payload).unwrap();
        // Wire header: salt(16) || rs(4) || keyid_len(1) || keyid(65)
        assert_eq!(wire.len(), 86 + payload.len() + 1 + 16);
        assert_eq!(u32::from_be_bytes([wire[16], wire[17], wire[18], wire[19]]), 4096);
        assert_eq!(wire[20], 65);
        let keyid = &wire[21..86];
        assert_eq!(keyid[0], 0x04);
        // Independent client-side decryption, exactly as a browser would do
        // (RFC 8291: ua public key first, application server second, no AAD).
        let eph_pub = PublicKey::from_sec1_bytes(keyid).unwrap();
        let ecdh = diffie_hellman(client.to_nonzero_scalar(), eph_pub.as_affine());
        let shared = ecdh.raw_secret_bytes();
        let mut info1 = Vec::with_capacity(14 + 130);
        info1.extend_from_slice(b"WebPush: info\0");
        info1.extend_from_slice(&client_pub_bytes);
        info1.extend_from_slice(keyid);
        let mut hkdf_auth = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&[3u8; 16]), shared)
            .expand(&info1, &mut hkdf_auth)
            .unwrap();
        let mut cek = [0u8; 16];
        Hkdf::<Sha256>::new(Some(&wire[0..16]), &hkdf_auth)
            .expand(b"Content-Encoding: aes128gcm\0", &mut cek)
            .unwrap();
        let mut nonce = [0u8; 12];
        Hkdf::<Sha256>::new(Some(&wire[0..16]), &hkdf_auth)
            .expand(b"Content-Encoding: nonce\0", &mut nonce)
            .unwrap();
        let cipher = Aes128Gcm::new(Key::<Aes128Gcm>::from_slice(&cek));
        let pt = cipher.decrypt(Nonce::from_slice(&nonce), &wire[86..]).unwrap();
        let mut expected = payload.as_bytes().to_vec();
        expected.push(0x02);
        assert_eq!(pt, expected);
    }
    #[test]
    fn origin_and_enabled() {
        assert_eq!(endpoint_origin("https://fcm.googleapis.com/fcm/send/x").as_deref(), Some("https://fcm.googleapis.com"));
        assert_eq!(endpoint_origin("http://127.0.0.1:4000/push").as_deref(), Some("http://127.0.0.1:4000"));
        assert!(endpoint_origin("not a url").is_none());
        assert!(endpoint_origin("https://bad host/x").is_none());
        assert!(push_enabled(&Config { vapid_private_key: b64url().encode([1u8; 32]), vapid_subject: String::new() }));
        assert!(!push_enabled(&Config { vapid_private_key: "   ".into(), vapid_subject: String::new() }));
        assert!(!push_enabled(&Config { vapid_private_key: "!!!".into(), vapid_subject: String::new() }));
    }

    #[test]
    fn amount_format() {
        assert_eq!(amount(&json!({"amountCents": 4250})), "42,50 EUR");
        assert_eq!(amount(&json!({"amountCents": 99})), "0,99 EUR");
        assert_eq!(amount(&json!({"amountCents": 42.5})), "0,42 EUR");
        assert_eq!(amount(&json!({"amountCents": "12"})), ""); // not a number
        assert_eq!(amount(&json!({})), "");
    }
}

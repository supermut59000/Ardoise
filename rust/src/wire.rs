//! Wire types — the exact camelCase shapes the React client speaks.
//! Validation mirrors the Pydantic bounds in backend/app/schemas/sync.py so a
//! malformed op is a clean 422, never a 500 the client would retry forever.

use serde::{Deserialize, Serialize};
use serde_json::Value;

const MAX_I63: u64 = i64::MAX as u64;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationWire {
    pub op_id: String,
    pub group_id: String,
    pub entity: String,
    pub entity_id: String,
    pub action: String,
    pub payload: Value,
    pub actor: String,
    pub lamport: u64,
    pub created_at: u64,
}

impl OperationWire {
    /// Mirrors the Pydantic Field bounds. First error message wins.
    pub fn validate(&self) -> Result<(), String> {
        let bad = |f: &str, why: &str| format!("{f}: {why}");
        if !(1..=36).contains(&self.op_id.chars().count()) {
            return Err(bad("opId", "1..=36 chars"));
        }
        if !(1..=36).contains(&self.group_id.chars().count()) {
            return Err(bad("groupId", "1..=36 chars"));
        }
        if !matches!(self.entity.as_str(), "group" | "member" | "expense" | "settlement") {
            return Err(bad("entity", "group|member|expense|settlement"));
        }
        if !(1..=36).contains(&self.entity_id.chars().count()) {
            return Err(bad("entityId", "1..=36 chars"));
        }
        if !matches!(self.action.as_str(), "create" | "update" | "delete") {
            return Err(bad("action", "create|update|delete"));
        }
        if !self.payload.is_object() {
            return Err(bad("payload", "must be a JSON object"));
        }
        if self.actor.chars().count() > 64 {
            return Err(bad("actor", "<=64 chars"));
        }
        // Bounded to BIGINT (red-team F8: unbounded ints 500 at the DB).
        if self.lamport > MAX_I63 {
            return Err(bad("lamport", "<= 2^63-1"));
        }
        if self.created_at > MAX_I63 {
            return Err(bad("createdAt", "<= 2^63-1"));
        }
        Ok(())
    }

    pub fn to_out(&self) -> Value {
        serde_json::json!({
            "opId": self.op_id,
            "groupId": self.group_id,
            "entity": self.entity,
            "entityId": self.entity_id,
            "action": self.action,
            "payload": self.payload,
            "actor": self.actor,
            "lamport": self.lamport,
            "createdAt": self.created_at,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    pub ops: Vec<OperationWire>,
    #[serde(default)]
    pub reseed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushResponse {
    pub accepted: i64,
    pub cursor: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullResponse {
    pub ops: Vec<Value>,
    pub cursor: i64,
    pub server_generation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterRequest {
    pub group_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupOut {
    pub group_id: String,
    pub share_code: String,
    pub server_generation: String,
}

// --- push subscriptions ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeRequest {
    pub endpoint: String,
    pub keys: PushKeys,
    pub device_id: String,
    pub group_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct PushKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Deserialize)]
pub struct UnsubscribeRequest {
    pub endpoint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VapidPublicOut {
    pub public_key: String,
}

/// https-only endpoint (red-team F11: SSRF via a handable endpoint URL).
pub fn validate_endpoint(ep: &str) -> Result<(), String> {
    if ep.chars().count() > 500 {
        return Err("endpoint: <=500 chars".into());
    }
    if !ep.starts_with("https://") {
        return Err("endpoint doit être une URL https".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(mut f: impl FnMut(&mut OperationWire)) -> OperationWire {
        let mut o = OperationWire {
            op_id: "abc".into(),
            group_id: "g1".into(),
            entity: "expense".into(),
            entity_id: "e1".into(),
            action: "create".into(),
            payload: serde_json::json!({}),
            actor: "dev".into(),
            lamport: 1,
            created_at: 1,
        };
        f(&mut o);
        o
    }

    #[test]
    fn validation_bounds() {
        assert!(op(|_| {}).validate().is_ok());
        assert!(op(|o| o.op_id = "x".repeat(37)).validate().is_err());
        assert!(op(|o| o.op_id = "".into()).validate().is_err());
        assert!(op(|o| o.entity = "invoice".into()).validate().is_err());
        assert!(op(|o| o.action = "upsert".into()).validate().is_err());
        assert!(op(|o| o.payload = Value::String("nope".into())).validate().is_err());
        assert!(op(|o| o.actor = "x".repeat(65)).validate().is_err());
        // F8: huge ints must not reach the DB.
        assert!(op(|o| o.lamport = u64::MAX).validate().is_err());
        assert!(op(|o| o.created_at = (i64::MAX as u64) + 1).validate().is_err());
        assert!(validate_endpoint("https://fcm.example/x").is_ok());
        assert!(validate_endpoint("http://172.17.0.1").is_err()); // F11 SSRF
    }
}

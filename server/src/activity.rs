//! Durable activity snapshots. Captured with the owning game transaction, never after it.
//! No balance changes or inferred cross-app account links are performed here.
use crate::db::{self, Cond, DbError, DbResult, Item, Tx};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub shop_seconds: i64,
    pub volunteer_seconds: i64,
    pub packs_opened: i64,
    pub battle_wins: i64,
    pub battle_losses: i64,
    pub battle_draws: i64,
    pub fmea_submitted: i64,
}

#[derive(Serialize)]
pub struct Subject {
    pub namespace: &'static str,
    pub id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub schema_version: u32,
    pub event_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub source: &'static str,
    pub org_id: String,
    pub entity_id: String,
    pub entity_version: u32,
    pub subject: Subject,
    pub occurred_at: String,
    pub effective_date: String,
    pub metrics: Metrics,
}

pub fn snapshot(org: &str, kind: &str, entity: &str, user: Uuid, at: i64, metrics: Metrics) -> DbResult<Activity> {
    let valid_org = !org.is_empty()
        && org.len() <= 64
        && org.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && org.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    let valid_metrics = metrics.shop_seconds == 0
        && metrics.volunteer_seconds == 0
        && metrics.fmea_submitted == 0
        && match kind {
            "packs.pack.opened.v1" => {
                metrics.packs_opened == 1
                    && metrics.battle_wins == 0
                    && metrics.battle_losses == 0
                    && metrics.battle_draws == 0
            }
            "packs.battle.finalized.v1" => {
                metrics.packs_opened == 0
                    && [metrics.battle_wins, metrics.battle_losses, metrics.battle_draws]
                        .iter()
                        .all(|v| *v == 0 || *v == 1)
                    && metrics.battle_wins + metrics.battle_losses + metrics.battle_draws == 1
            }
            _ => false,
        };
    if !valid_org || !valid_metrics || entity.is_empty() || entity.len() > 512 {
        return Err(DbError::Other("invalid activity snapshot configuration".into()));
    }
    let instant = DateTime::<Utc>::from_timestamp_millis(at)
        .ok_or_else(|| DbError::Other("invalid activity timestamp".into()))?;
    let id = user.to_string();
    let identity = serde_json::json!([org, "packs", kind, entity, 1, "packs.player", id]);
    let event_id = hex::encode(Sha256::digest(serde_json::to_vec(&identity).expect("identity serializes")));
    Ok(Activity {
        schema_version: 1,
        event_id,
        event_type: kind.to_owned(),
        source: "packs",
        org_id: org.to_owned(),
        entity_id: entity.to_owned(),
        entity_version: 1,
        subject: Subject { namespace: "packs.player", id },
        occurred_at: instant.to_rfc3339_opts(SecondsFormat::Millis, true),
        effective_date: instant.with_timezone(&chrono_tz::America::Chicago).format("%Y-%m-%d").to_string(),
        metrics,
    })
}

pub fn outbox_item(e: &Activity) -> Item {
    let mut it = db::key(format!("OUTBOX#{}#packs#{}", e.org_id, &e.occurred_at[..10]), &e.event_id);
    for (key, value) in [
        ("recordType", "ACTIVITY_OUTBOX_V1"),
        ("eventId", e.event_id.as_str()),
        ("eventType", e.event_type.as_str()),
        ("source", "packs"),
        ("orgId", e.org_id.as_str()),
        ("entityId", e.entity_id.as_str()),
        ("subjectNamespace", "packs.player"),
        ("subjectId", e.subject.id.as_str()),
        ("occurredAt", e.occurred_at.as_str()),
        ("effectiveDate", e.effective_date.as_str()),
    ] {
        it.insert(key.into(), db::s(value));
    }
    it.insert("schemaVersion".into(), db::n(1));
    it.insert("entityVersion".into(), db::n(1));
    for (key, value) in
        serde_json::to_value(&e.metrics).expect("metrics serialize").as_object().expect("metrics are an object")
    {
        it.insert(key.clone(), db::n(value.as_i64().expect("integer metric")));
    }
    it
}

pub fn capture(tx: &mut Tx, kind: &str, entity: &str, user: Uuid, at: i64, metrics: Metrics) -> DbResult<()> {
    if std::env::var("INTEGRATION_ENABLED").as_deref() != Ok("true") {
        return Ok(());
    }
    let org =
        std::env::var("INTEGRATION_ORG_ID").map_err(|_| DbError::Other("INTEGRATION_ORG_ID is required".into()))?;
    let event = snapshot(&org, kind, entity, user, at, metrics)?;
    if tx.len() >= 100 {
        return Err(DbError::Other("activity transaction exceeds DynamoDB item limit".into()));
    }
    tx.put_if("activity", outbox_item(&event), Some(Cond::absent()));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_language_neutral_pack_and_battle_fixtures() {
        let fixtures: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../contracts/fixtures/activity-v1.json")).unwrap();
        let user = Uuid::parse_str("00000000-0000-4000-8000-000000000001").unwrap();
        let at = DateTime::parse_from_rfc3339("2026-11-04T18:00:00.000Z").unwrap().timestamp_millis();
        let pack = snapshot(
            "example-team",
            "packs.pack.opened.v1",
            "opening:17",
            user,
            at,
            Metrics { packs_opened: 1, ..Default::default() },
        )
        .unwrap();
        let battle = snapshot(
            "example-team",
            "packs.battle.finalized.v1",
            "battle:example-game",
            user,
            at,
            Metrics { battle_wins: 1, ..Default::default() },
        )
        .unwrap();
        assert_eq!(serde_json::to_value(&pack).unwrap(), fixtures[1]);
        assert_eq!(serde_json::to_value(&battle).unwrap(), fixtures[2]);
        let item = outbox_item(&pack);
        assert_eq!(db::get_s(&item, "recordType").as_deref(), Some("ACTIVITY_OUTBOX_V1"));
        assert!(!item.contains_key("expires_at"));
    }
    #[test]
    fn validates_ownership_and_organization_and_uses_chicago_business_date() {
        let user = Uuid::nil();
        let at = DateTime::parse_from_rfc3339("2026-11-04T01:00:00.000Z").unwrap().timestamp_millis();
        let metrics = Metrics { packs_opened: 1, ..Default::default() };
        assert!(snapshot("Example#bad", "packs.pack.opened.v1", "opening:1", user, at, metrics.clone()).is_err());
        assert!(snapshot("example-team", "puncher.credit.changed.v1", "opening:1", user, at, metrics.clone()).is_err());
        assert_eq!(
            snapshot("example-team", "packs.pack.opened.v1", "opening:1", user, at, metrics).unwrap().effective_date,
            "2026-11-03"
        );
    }
}

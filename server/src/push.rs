//! Push notifications (Web Push): no outside account or keys. The server signs its messages with its own key (VAPID),
//! made on first start and kept in the database, and sends them to each subscribed browser's push service (Google,
//! Mozilla or Apple). Each kind can be turned off in Settings (KINDS): a free pack is ready, a trade offer (or counter-
//! offer) for you, your offer was accepted or declined, an opponent joined your game, and news (accepted feedback,
//! rarity changes).

use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};
use tokio::sync::OnceCell;
use uuid::Uuid;
use web_push_native::jwt_simple::algorithms::{ECDSAP256PublicKeyLike, ES256KeyPair};
use web_push_native::{Auth, WebPushBuilder};

use crate::Shared;
use crate::auth::User;
use crate::db::{Cond, Db, DbError, Tx, get_n, get_s, key as dkey, n, pad, s as sv};
use crate::error::{ApiError, ApiResult};
use crate::model::{self, Profile, now_ms, upk};
use crate::retry;

pub fn routes() -> Router<Shared> {
    Router::new()
        .route("/push/key", get(key))
        .route("/push/subscribe", post(subscribe))
        .route("/push/unsubscribe", post(unsubscribe))
        .route("/push/prefs", post(prefs))
}

/// Every kind of notification, as Settings names them.
pub const KINDS: [&str; 6] = ["pack", "offer", "accepted", "declined", "match", "news"];

#[derive(Deserialize)]
struct PrefsReq {
    /// The kinds to turn off; everything else is on.
    off: Vec<String>,
}

/// Saves which kinds of notification this player wants. Returns the kinds now off.
async fn prefs(State(s): State<Shared>, user: User, Json(req): Json<PrefsReq>) -> ApiResult<Json<Vec<String>>> {
    if req.off.iter().any(|k| !KINDS.contains(&k.as_str())) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "bad_request"));
    }
    let mut off: Vec<String> = KINDS.iter().filter(|k| req.off.iter().any(|o| o == *k)).map(|k| k.to_string()).collect();
    off.dedup();
    let db = &s.db;
    retry!(async {
        let Some(mut p) = model::profile(db, user.id).await? else {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "not_found"));
        };
        p.notify_off = off.clone();
        let parts = p.parts;
        let mut tx = Tx::new();
        model::save_user(&mut tx, &mut p, parts, "settings");
        tx.commit(db).await.map_err(ApiError::from)
    })?;
    Ok(Json(off))
}

struct Pusher {
    keys: ES256KeyPair,
    /// The VAPID public key the browser needs to subscribe: an uncompressed P-256 point, base64url.
    public: String,
    http: reqwest::Client,
    /// Who push services can contact about these messages.
    contact: String,
}

static PUSHER: OnceCell<Option<Pusher>> = OnceCell::const_new();

/// The signing key, made and saved on first use. None if it can't be set up (push is then just off).
async fn pusher(db: &Db) -> Option<&'static Pusher> {
    PUSHER
        .get_or_init(|| async {
            match load(db).await {
                Ok(p) => Some(p),
                Err(e) => {
                    tracing::warn!("push notifications are off: {e:#}");
                    None
                }
            }
        })
        .await
        .as_ref()
}

async fn load(db: &Db) -> anyhow::Result<Pusher> {
    let saved = get_s(&model::settings_item(db).await?, "vapid_private");
    let keys = match saved {
        Some(k) => ES256KeyPair::from_bytes(&URL_SAFE_NO_PAD.decode(k)?)?,
        None => {
            let k = ES256KeyPair::generate();
            // Two servers starting at once: keep whichever key was saved first.
            let mut tx = Tx::new();
            tx.update(
                "",
                "SETTINGS",
                "SETTINGS",
                Cond::new("SET vapid_private = :k").val(":k", sv(URL_SAFE_NO_PAD.encode(k.to_bytes()))),
                Some("attribute_not_exists(vapid_private)"),
            );
            match tx.commit(db).await {
                Ok(()) | Err(DbError::Conflict(_)) => {}
                Err(e) => return Err(e.into()),
            }
            let k = get_s(&model::settings_item(db).await?, "vapid_private")
                .ok_or_else(|| anyhow::anyhow!("no push key"))?;
            ES256KeyPair::from_bytes(&URL_SAFE_NO_PAD.decode(k)?)?
        }
    };
    let public = URL_SAFE_NO_PAD.encode(keys.public_key().public_key().to_bytes_uncompressed());
    // No redirects: a push service answers directly, and following one could lead somewhere it shouldn't.
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let contact = std::env::var("PUSH_CONTACT").unwrap_or_else(|_| "https://github.com/STMARobotics/frc-packs".into());
    Ok(Pusher { keys, public, http, contact })
}

#[derive(Serialize)]
struct KeyOut {
    key: Option<String>,
}

async fn key(State(s): State<Shared>, _user: User) -> ApiResult<Json<KeyOut>> {
    Ok(Json(KeyOut { key: pusher(&s.db).await.map(|p| p.public.clone()) }))
}

#[derive(Deserialize)]
struct Keys {
    p256dh: String,
    auth: String,
}

#[derive(Deserialize)]
struct SubscribeReq {
    endpoint: String,
    keys: Keys,
}

fn bad() -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, "bad_request")
}

/// Hosts of the browsers' push services. Subscriptions are only accepted for these, so a player can't point the server at
/// some other address.
const PUSH_HOSTS: [&str; 6] = [
    "fcm.googleapis.com",
    "android.googleapis.com",
    "push.services.mozilla.com",
    "push.apple.com",
    "notify.windows.com",
    "push.microsoft.com",
];

/// True for an https address on one of the real push services (or a sub-domain of one).
pub fn is_push_service(endpoint: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else { return false };
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.host_str().is_some_and(|h| {
            PUSH_HOSTS.iter().any(|ok| h == *ok || h.strip_suffix(ok).is_some_and(|rest| rest.ends_with('.')))
        })
}

/// Turns notifications on for this browser. A browser's subscription belongs to whoever signed in on it last.
async fn subscribe(State(s): State<Shared>, user: User, Json(req): Json<SubscribeReq>) -> ApiResult<StatusCode> {
    // Only real push services, over HTTPS; keys must decode.
    let ok_url = req.endpoint.len() < 1000 && is_push_service(&req.endpoint);
    let ok_keys = URL_SAFE_NO_PAD.decode(req.keys.p256dh.trim_end_matches('=')).is_ok_and(|k| k.len() == 65)
        && URL_SAFE_NO_PAD.decode(req.keys.auth.trim_end_matches('=')).is_ok_and(|k| k.len() == 16);
    if !ok_url || !ok_keys {
        return Err(bad());
    }
    let mut subs = subs_of(&s.db, user.id).await?;
    if subs.len() >= 10 && !subs.iter().any(|x| x.0 == req.endpoint) {
        // Ten devices is plenty; drop the oldest.
        subs.sort_by_key(|x| x.3);
        s.db.delete(&push_pk(&subs[0].0), "PUSH").await?;
    }
    let now = now_ms();
    let mut it = dkey(push_pk(&req.endpoint), "PUSH");
    it.insert("endpoint".into(), sv(req.endpoint.clone()));
    it.insert("user_id".into(), sv(user.id.to_string()));
    it.insert("p256dh".into(), sv(req.keys.p256dh.trim_end_matches('=')));
    it.insert("auth".into(), sv(req.keys.auth.trim_end_matches('=')));
    it.insert("created_at".into(), n(now));
    it.insert("gsi2pk".into(), sv(upk(user.id)));
    it.insert("gsi2sk".into(), sv(format!("PUSH#{}", pad(now, 15))));
    s.db.put(it).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct UnsubscribeReq {
    endpoint: String,
}

async fn unsubscribe(State(s): State<Shared>, user: User, Json(req): Json<UnsubscribeReq>) -> ApiResult<StatusCode> {
    if let Some(it) = s.db.get(&push_pk(&req.endpoint), "PUSH").await?
        && get_s(&it, "user_id").as_deref() == Some(user.id.to_string().as_str())
    {
        s.db.delete(&push_pk(&req.endpoint), "PUSH").await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct Note {
    pub title: String,
    pub body: String,
    /// Where tapping it goes, like "/#trade".
    pub url: String,
    /// Notifications with the same tag replace each other instead of piling up.
    pub tag: String,
    /// Which setting turns it off (one of KINDS).
    #[serde(skip)]
    pub kind: &'static str,
}

/// Sends a notification to every device the account turned them on for. Subscriptions the push service says are gone
/// are deleted. On a server it goes out in the background; on AWS Lambda nothing runs after the response is sent, so it
/// is sent before returning (for at most a few seconds).
pub async fn notify(db: &Db, user: Uuid, note: Note) {
    let db = db.clone();
    let job = async move {
        if let Err(e) = send(&db, user, &note).await {
            tracing::warn!("push to {user} failed: {e:#}");
        }
    };
    if std::env::var("AWS_LAMBDA_RUNTIME_API").is_ok() {
        if tokio::time::timeout(Duration::from_secs(4), job).await.is_err() {
            tracing::warn!("push to {user} took too long and was dropped");
        }
    } else {
        tokio::spawn(job);
    }
}

async fn send(db: &Db, user: Uuid, note: &Note) -> anyhow::Result<()> {
    let subs: Vec<(String, String, String)> = subs_of(db, user).await?.into_iter().map(|x| (x.0, x.1, x.2)).collect();
    if subs.is_empty() {
        return Ok(());
    }
    if model::profile(db, user).await?.is_some_and(|p| p.notify_off.iter().any(|k| k == note.kind)) {
        return Ok(());
    }
    let Some(p) = pusher(db).await else { return Ok(()) };
    let body = serde_json::to_vec(note)?;
    for (endpoint, p256dh, auth) in subs {
        let ua_public = web_push_native::p256::PublicKey::from_sec1_bytes(&URL_SAFE_NO_PAD.decode(&p256dh)?)?;
        let ua_auth = Auth::clone_from_slice(&URL_SAFE_NO_PAD.decode(&auth)?);
        let req = WebPushBuilder::new(endpoint.parse()?, ua_public, ua_auth)
            .with_valid_duration(Duration::from_secs(6 * 3600))
            .with_vapid(&p.keys, &p.contact)
            .build(body.clone())?;
        let (parts, payload) = req.into_parts();
        let mut r = p.http.post(endpoint.as_str()).body(payload);
        for (k, v) in parts.headers.iter() {
            r = r.header(k.as_str(), v.as_bytes());
        }
        // Without this, phones saving battery hold "normal" pushes until they're woken up, so a trade offer could
        // only show up once the app was opened. There are few of these, so each one may wake the phone.
        r = r.header("Urgency", "high");
        match r.send().await {
            Ok(res) if res.status() == reqwest::StatusCode::NOT_FOUND || res.status() == reqwest::StatusCode::GONE => {
                db.delete(&push_pk(&endpoint), "PUSH").await?;
            }
            Ok(res) if !res.status().is_success() => {
                tracing::warn!("push service answered {} for one of {user}'s devices", res.status());
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("push send failed: {e}"),
        }
    }
    Ok(())
}

fn push_pk(endpoint: &str) -> String {
    format!(
        "PUSH#{}",
        hex::encode(sha2::Digest::finalize(<sha2::Sha256 as sha2::Digest>::new_with_prefix(endpoint.as_bytes())))
    )
}

/// A player's push subscriptions: endpoint, keys, when made.
async fn subs_of(db: &Db, user: Uuid) -> Result<Vec<(String, String, String, i64)>, DbError> {
    let rows = db.index("gsi2", &upk(user), None, false).await?;
    Ok(rows
        .iter()
        .filter(|it| get_s(it, "sk").as_deref() == Some("PUSH"))
        .filter_map(|it| {
            Some((
                get_s(it, "endpoint")?,
                get_s(it, "p256dh")?,
                get_s(it, "auth")?,
                get_n(it, "created_at").unwrap_or(0),
            ))
        })
        .collect())
}

/// Once a minute: tell everyone whose free pack just became ready (once per timer), if they turned notifications on.
/// On AWS Lambda nothing runs between requests, so an EventBridge schedule calls [`ready_check`] instead.
pub async fn ready_loop(db: Db) {
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    loop {
        tick.tick().await;
        if let Err(e) = ready_check(&db).await {
            tracing::warn!("checking free packs for notifications failed: {e}");
        }
    }
}

pub async fn ready_check(db: &Db) -> anyhow::Result<()> {
    let now = now_ms();
    for it in db.index("gsi1", "USERS", None, false).await? {
        let Ok(p) = crate::db::from_item::<Profile>(it) else { continue };
        let due = p.next_claim_at <= now
            && p.next_claim_at > now - 86_400_000
            && p.pack_ping_at.is_none_or(|t| t < p.next_claim_at);
        if !due || p.disabled || p.notify_off.iter().any(|k| k == "pack") || subs_of(db, p.id).await?.is_empty() {
            continue;
        }
        // Mark it pinged (on the player's version, so a claim at the same moment isn't overwritten).
        let marked: ApiResult<bool> = retry!(async {
            let Some(mut p) = model::profile(db, p.id).await? else { return Ok(false) };
            if p.pack_ping_at.is_some_and(|t| t >= p.next_claim_at) {
                return Ok(false);
            }
            p.pack_ping_at = Some(p.next_claim_at);
            let parts = p.parts;
            let mut tx = Tx::new();
            model::save_user(&mut tx, &mut p, parts, "push");
            tx.commit(db).await.map(|_| true).map_err(ApiError::from)
        });
        if matches!(marked, Ok(true)) {
            notify(
                db,
                p.id,
                Note {
                    title: "A free pack is ready".into(),
                    body: "Your free FRC Packs pack is waiting. Come claim it!".into(),
                    url: "/#open".into(),
                    tag: "pack-ready".into(),
                    kind: "pack",
                },
            )
            .await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::is_push_service;

    #[test]
    fn only_real_push_services_are_accepted() {
        for ok in [
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/abc",
            "https://web.push.apple.com/QGx",
            "https://wns2-par02p.notify.windows.com/w/?token=x",
        ] {
            assert!(is_push_service(ok), "{ok}");
        }
        for bad in [
            "http://fcm.googleapis.com/x",
            "https://evil.example/x",
            "https://fcm.googleapis.com.evil.example/x",
            "https://evilfcm.googleapis.com/x",
            "https://user@fcm.googleapis.com/x",
            "https://fcm.googleapis.com:8443/x",
            "https://127.0.0.1/x",
            "https://localhost/x",
            "not a url",
        ] {
            assert!(!is_push_service(bad), "{bad}");
        }
    }
}

//! API tests against a real DynamoDB. Set DYNAMODB_ENDPOINT (a local DynamoDB, e.g. http://localhost:8765) to run them;
//! without it they are skipped. Each test uses its own accounts, so they can share one table.

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use frc_packs_server::db::Db;
use frc_packs_server::testkit as kit;
use frc_packs_server::{Config, app};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use std::path::PathBuf;
use tower::ServiceExt;
use uuid::Uuid;

const PACK: &str = "cmp26";

async fn table(name: &str) -> Option<Db> {
    std::env::var("DYNAMODB_ENDPOINT").ok()?;
    // Server errors (say, a database error) print with the failing test.
    let _ = tracing_subscriber::fmt().with_test_writer().with_env_filter("frc_packs_server=error").try_init();
    let db = frc_packs_server::db::connect(name).await;
    frc_packs_server::prepare(&db).await.unwrap();
    Some(db)
}

fn router(db: &Db, dev_tools: bool, admin_only: bool) -> Router {
    let data_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../data");
    app(db.clone(), Config { data_dir, web_dir: None, dev_tools, cookie_secure: false, admin_only }).unwrap()
}

/// A table of the test's own (for checks that other tests running at the same time would upset), dropped by `drop_table`.
async fn own_setup(dev_tools: bool) -> Option<(Router, Db)> {
    let db = table(&format!("frc-own-{}", Uuid::new_v4().simple())).await?;
    Some((router(&db, dev_tools, false), db))
}

async fn drop_table(db: &Db) {
    db.client.delete_table().table_name(&db.table).send().await.ok();
}

async fn setup(dev_tools: bool) -> Option<(Router, Db)> {
    let db = table("frc-packs-test").await?;
    Some((router(&db, dev_tools, false), db))
}

struct Res {
    status: StatusCode,
    cookie: Option<String>,
    body: Value,
}

async fn call(app: &Router, method: &str, path: &str, cookie: Option<&str>, body: Option<Value>) -> Res {
    call_key(app, method, path, cookie, body, None).await
}

/// `call` with an Idempotency-Key header.
async fn call_key(
    app: &Router,
    method: &str,
    path: &str,
    cookie: Option<&str>,
    body: Option<Value>,
    key: Option<&str>,
) -> Res {
    let mut b = Request::builder().method(method).uri(path);
    if let Some(k) = key {
        b = b.header("idempotency-key", k);
    }
    if let Some(c) = cookie {
        b = b.header(header::COOKIE, c);
    }
    let req = match body {
        Some(v) => b.header(header::CONTENT_TYPE, "application/json").body(Body::from(v.to_string())).unwrap(),
        None => b.body(Body::empty()).unwrap(),
    };
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let cookie =
        res.headers().get(header::SET_COOKIE).map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string());
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    Res { status, cookie, body }
}

fn name() -> String {
    format!("u{}", &Uuid::new_v4().simple().to_string()[..12])
}

/// A new player: makes a single-use invite code and signs up with it. Returns the session cookie and the state.
async fn player(app: &Router, db: &Db) -> (String, Value) {
    let (_, cookie, state) = signup(app, db, &name()).await;
    (cookie, state)
}

async fn signup(app: &Router, db: &Db, username: &str) -> (String, String, Value) {
    let code = kit::invite(db, 1).await;
    let r = call(
        app,
        "POST",
        "/api/signup",
        None,
        Some(json!({ "code": code, "username": username, "password": "hunter22!", "firstName": "Test" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    (username.to_string(), r.cookie.expect("signing up sets a cookie"), r.body)
}

async fn user_id(db: &Db, cookie: &str) -> Uuid {
    kit::user_by_cookie(db, cookie).await
}

async fn make_admin(app: &Router, db: &Db) -> String {
    let (_, cookie, _) = signup(app, db, &name()).await;
    kit::make_admin(db, user_id(db, &cookie).await).await;
    cookie
}

/// Makes accounts two days old, past the new-account trading rule.
async fn age(db: &Db, ids: &[Uuid]) {
    for id in ids {
        kit::age(db, *id, 48).await;
    }
}

fn sealed(state: &Value) -> i64 {
    state["packs"].as_array().unwrap().iter().find(|p| p["id"] == PACK).unwrap()["sealed"].as_i64().unwrap()
}

fn packs_of(st: &Value) -> (i64, i64) {
    let p = st["packs"].as_array().unwrap().iter().find(|p| p["id"] == PACK).unwrap();
    (p["sealed"].as_i64().unwrap(), p["boosted"].as_i64().unwrap())
}

const ORDER: [&str; 5] = ["common", "uncommon", "rare", "legendary", "mythic"];
fn rank(t: &Value) -> usize {
    ORDER.iter().position(|x| *x == t.as_str().unwrap()).unwrap()
}

/// The nth team of a tier in the 2026 Championship pack.
fn team_of(tier: &str, nth: usize) -> i32 {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../data/packs/cmp26.json");
    let recipe: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    recipe["teams"].as_array().unwrap().iter().filter(|t| t["tier"] == tier).nth(nth).unwrap()["num"].as_i64().unwrap()
        as i32
}

fn recipe() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../data/packs/cmp26.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

async fn give_card(db: &Db, user: Uuid, team: i32, tier: &str) -> i32 {
    kit::give_card(db, user, PACK, team, tier).await
}

async fn futures_join<F: std::future::Future<Output = Res> + Send + 'static>(fs: Vec<F>) -> Vec<Res> {
    let handles: Vec<_> = fs.into_iter().map(tokio::spawn).collect();
    let mut out = Vec::new();
    for h in handles {
        out.push(h.await.unwrap());
    }
    out
}

macro_rules! need_db {
    ($e:expr) => {
        match $e.await {
            Some(x) => x,
            None => {
                eprintln!("skipped: set DYNAMODB_ENDPOINT to run API tests");
                return;
            }
        }
    };
}

#[tokio::test]
async fn new_account_session_and_state() {
    let (app, db) = need_db!(setup(true));
    let (cookie, state) = player(&app, &db).await;
    assert_eq!(sealed(&state), 2, "new accounts start with 2 packs");
    assert!(
        state["nextClaimAt"].as_i64().unwrap() <= state["now"].as_i64().unwrap(),
        "a free pack is ready right away"
    );
    assert!(state["pending"].is_null());
    assert_eq!(state["account"]["admin"], false);
    let again = call(&app, "POST", "/api/session", Some(&cookie), Some(json!({}))).await;
    assert_eq!(again.status, StatusCode::OK);
    assert!(again.cookie.is_none(), "an existing session is kept");
    assert_eq!(again.body["account"], state["account"]);
    let nobody = call(&app, "POST", "/api/session", None, Some(json!({}))).await;
    assert_eq!((nobody.status, nobody.body["error"].as_str()), (StatusCode::UNAUTHORIZED, Some("sign_in")));
    assert_eq!(call(&app, "GET", "/api/state", Some(&cookie), None).await.status, StatusCode::OK);
    let anon = call(&app, "GET", "/api/state", None, None).await;
    assert_eq!(anon.status, StatusCode::UNAUTHORIZED);
    assert_eq!(anon.body["error"], "no_session");
    let forged = call(&app, "GET", "/api/state", Some("sid=not-a-real-token"), None).await;
    assert_eq!(forged.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn claims_follow_the_timer_and_bank_two() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    let r = call(&app, "POST", "/api/claim", Some(&c), Some(json!({}))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(sealed(&r.body), 3);
    let every = r.body["claimMs"].as_i64().unwrap();
    let wait = r.body["nextClaimAt"].as_i64().unwrap() - r.body["now"].as_i64().unwrap();
    assert!((every - 5000..=every).contains(&wait), "next claim in one timer, got {wait}ms");
    let r = call(&app, "POST", "/api/claim", Some(&c), Some(json!({}))).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "double claim does nothing");
    assert_eq!(r.body["error"], "not_ready");
    for _ in 0..3 {
        call(&app, "POST", "/api/dev/skip-timer", Some(&c), Some(json!({}))).await;
    }
    let r = call(&app, "POST", "/api/claim", Some(&c), Some(json!({}))).await;
    assert_eq!(sealed(&r.body), 5, "missed packs bank up to 2");
}

#[tokio::test]
async fn simultaneous_claims_pay_once() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    let tries: Vec<_> = (0..10)
        .map(|_| {
            let (app, c) = (app.clone(), c.clone());
            async move { call(&app, "POST", "/api/claim", Some(&c), Some(json!({}))).await }
        })
        .collect();
    let results = futures_join(tries).await;
    assert_eq!(results.iter().filter(|r| r.status == StatusCode::OK).count(), 1, "one claim of ten wins");
    assert!(results.iter().all(|r| r.status.as_u16() < 500));
    let st = call(&app, "GET", "/api/state", Some(&c), None).await.body;
    assert_eq!(sealed(&st), 3);
}

#[tokio::test]
async fn activity_outbox_is_atomic_and_pack_retries_publish_once() {
    if std::env::var("INTEGRATION_ENABLED").as_deref() != Ok("true") {
        return;
    }
    let (app, db) = need_db!(own_setup(true));
    let (cookie, _) = player(&app, &db).await;
    let uid = user_id(&db, &cookie).await;
    let request = Uuid::new_v4().to_string();
    let first = call_key(&app, "POST", "/api/open", Some(&cookie), Some(json!({ "pack": PACK })), Some(&request)).await;
    let replay =
        call_key(&app, "POST", "/api/open", Some(&cookie), Some(json!({ "pack": PACK })), Some(&request)).await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    assert_eq!(replay.body["opening"]["id"], first.body["opening"]["id"]);
    let events: Vec<_> = db
        .scan_all()
        .await
        .unwrap()
        .into_iter()
        .filter(|item| frc_packs_server::db::get_s(item, "recordType").as_deref() == Some("ACTIVITY_OUTBOX_V1"))
        .collect();
    assert_eq!(events.len(), 1);
    assert_eq!(frc_packs_server::db::get_s(&events[0], "subjectId"), Some(uid.to_string()));
    assert_eq!(frc_packs_server::db::get_n(&events[0], "packsOpened"), Some(1));

    let mut tx = frc_packs_server::db::Tx::new();
    frc_packs_server::activity::capture(
        &mut tx,
        "packs.pack.opened.v1",
        "opening:aborted",
        uid,
        frc_packs_server::model::now_ms(),
        frc_packs_server::activity::Metrics { packs_opened: 1, ..Default::default() },
    )
    .unwrap();
    tx.check(
        "forced",
        &frc_packs_server::model::upk(uid),
        "PROFILE",
        frc_packs_server::db::Cond::new("ver = :v").val(":v", frc_packs_server::db::n(-1)),
    );
    assert!(tx.commit(&db).await.is_err());
    assert!(
        !db.scan_all()
            .await
            .unwrap()
            .iter()
            .any(|item| { frc_packs_server::db::get_s(item, "entityId").as_deref() == Some("opening:aborted") })
    );
    drop_table(&db).await;
}

/// Picking up a pack opens it: there's no pack in hand any more, the route is gone, and an opening's cards enter the
/// game with their serial numbers at once.
#[tokio::test]
async fn picking_up_is_opening() {
    let (app, db) = need_db!(setup(false));
    let (c, _) = player(&app, &db).await;
    let r = call(&app, "POST", "/api/hand", Some(&c), Some(json!({ "pack": PACK }))).await;
    assert!(
        r.status == StatusCode::NOT_FOUND || r.status == StatusCode::METHOD_NOT_ALLOWED,
        "no /api/hand: {}",
        r.status
    );
    let o = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await;
    assert_eq!(o.status, StatusCode::OK, "{}", o.body);
    let cards = o.body["opening"]["cards"].as_array().unwrap();
    assert_eq!(cards.len(), 5);
    assert!(rank(&cards[4]["tier"]) >= 3, "first pack ends in Legendary or better");
    assert!(cards.iter().all(|x| x["serial"].as_i64().unwrap() >= 1));
    let teams: Vec<i32> = cards.iter().map(|x| x["num"].as_i64().unwrap() as i32).collect();
    assert!(teams_live(&db, &teams).await >= 5, "the cards are in the game");
    assert_eq!(o.body["state"]["pending"]["id"], o.body["opening"]["id"], "it resumes until it's revealed");
}

/// A pack picked up before picking up and opening became one step is dropped when the player next opens: its serial
/// numbers go back into circulation and the opening is a fresh roll, whatever the old pack held.
#[tokio::test]
async fn a_legacy_hand_is_released_on_open() {
    // Other tests opening packs could take the freed serial first: a table of its own.
    let (app, db) = need_db!(own_setup(false));
    let (c, _) = player(&app, &db).await;
    let user = user_id(&db, &c).await;
    call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await; // past the scripted first pack
    let m = team_of("mythic", 1);
    let hand = json!([
        { "num": team_of("common", 0), "tier": "common" }, { "num": team_of("common", 1), "tier": "common" },
        { "num": team_of("common", 2), "tier": "common" }, { "num": team_of("common", 3), "tier": "common" },
        { "num": m, "tier": "mythic" }
    ]);
    let mut it = frc_packs_server::db::key(frc_packs_server::model::upk(user), format!("HAND#{PACK}#0"));
    it.insert("cards".into(), frc_packs_server::db::s(hand.to_string()));
    it.insert("serials".into(), frc_packs_server::db::s("[901,902,903,904,905]"));
    db.put(it).await.unwrap();
    let o = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await;
    assert_eq!(o.status, StatusCode::OK, "{}", o.body);
    assert_eq!(kit::count_items(&db, user, "HAND#").await, 0, "the old pack in hand is gone");
    assert!(kit::free_serial(&db, PACK, m, 905).await, "its serial numbers are back in circulation");
    drop_table(&db).await;
}

async fn teams_live(db: &Db, teams: &[i32]) -> i64 {
    let mut n = 0;
    for t in teams {
        let it = db.get(&format!("PRINT#{PACK}#{t}"), "PRINT").await.unwrap().unwrap_or_default();
        n += frc_packs_server::db::get_n(&it, "live").unwrap_or(0);
    }
    n
}

#[tokio::test]
async fn reveal_progress_and_resume() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    let o = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await;
    let id = o.body["opening"]["id"].as_i64().unwrap();
    let p = call(&app, "POST", &format!("/api/openings/{id}/progress"), Some(&c), Some(json!({ "revealed": 3 }))).await;
    assert_eq!(p.status, StatusCode::NO_CONTENT);
    let s = call(&app, "GET", "/api/state", Some(&c), None).await;
    assert_eq!(s.body["pending"]["revealed"], 3);
    call(&app, "POST", &format!("/api/openings/{id}/progress"), Some(&c), Some(json!({ "revealed": 1 }))).await;
    let s = call(&app, "GET", "/api/state", Some(&c), None).await;
    assert_eq!(s.body["pending"]["revealed"], 3, "progress never goes backwards");
    call(&app, "POST", &format!("/api/openings/{id}/progress"), Some(&c), Some(json!({ "revealed": 5 }))).await;
    let s = call(&app, "GET", "/api/state", Some(&c), None).await;
    assert!(s.body["pending"].is_null(), "a finished pack no longer resumes");
    let (other, _) = player(&app, &db).await;
    let p =
        call(&app, "POST", &format!("/api/openings/{id}/progress"), Some(&other), Some(json!({ "revealed": 5 }))).await;
    assert_eq!(p.status, StatusCode::NOT_FOUND, "can't touch someone else's pack");
}

#[tokio::test]
async fn no_packs_no_opening() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    for _ in 0..2 {
        assert_eq!(
            call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await.status,
            StatusCode::OK
        );
    }
    let r = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.body["error"], "no_packs");
    let r = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": "nope" }))).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn two_tabs_cannot_open_one_pack_twice() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await; // leaves 1 sealed
    let tries: Vec<_> = (0..6)
        .map(|_| {
            let (app, c) = (app.clone(), c.clone());
            async move { call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await }
        })
        .collect();
    let results = futures_join(tries).await;
    let ok = results.iter().filter(|r| r.status == StatusCode::OK).count();
    assert_eq!(ok, 1, "exactly one of the simultaneous opens wins");
    assert!(results.iter().all(|r| r.status.as_u16() < 500), "no server errors");
    let s = call(&app, "GET", "/api/state", Some(&c), None).await;
    assert_eq!(sealed(&s.body), 0);
    let me = user_id(&db, &c).await;
    assert_eq!(kit::all_cards(&db, me, PACK).await.len(), 10, "two packs, ten cards, no more");
}

#[tokio::test]
async fn serials_count_up_and_collection_matches() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    for _ in 0..8 {
        call(&app, "POST", "/api/dev/pack", Some(&c), Some(json!({ "pack": PACK }))).await;
    }
    let mut opened = 0;
    while call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await.status == StatusCode::OK {
        opened += 1;
    }
    assert_eq!(opened, 10);
    let col = call(&app, "GET", &format!("/api/collection/{PACK}"), Some(&c), None).await;
    let cards = col.body["cards"].as_array().unwrap();
    let total: usize = cards.iter().map(|x| x["serials"].as_array().unwrap().len()).sum();
    assert_eq!(total, 50, "every card from 10 packs is in the collection");
    for x in cards {
        let s: Vec<i64> = x["serials"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
        assert!(s.windows(2).all(|w| w[0] < w[1]), "serials for one team count up: {s:?}");
    }
}

/// Many players opening the same teams at once never get the same serial number.
#[tokio::test]
async fn simultaneous_pulls_of_one_team_get_different_serials() {
    let (app, db) = need_db!(setup(true));
    let teams: Vec<(i32, &str)> = vec![
        (team_of("common", 145), "common"),
        (team_of("common", 146), "common"),
        (team_of("uncommon", 145), "uncommon"),
        (team_of("rare", 115), "rare"),
        (team_of("legendary", 40), "legendary"),
    ];
    let hand = json!(teams.iter().map(|(n, t)| json!({ "num": n, "tier": t })).collect::<Vec<_>>());
    let mut cookies = Vec::new();
    for _ in 0..8 {
        let (c, _) = player(&app, &db).await;
        kit::rig_next(&db, user_id(&db, &c).await, PACK, &hand).await;
        cookies.push(c);
    }
    let jobs: Vec<_> = cookies
        .iter()
        .map(|c| {
            let (app, c) = (app.clone(), c.clone());
            async move { call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await }
        })
        .collect();
    let results = futures_join(jobs).await;
    for r in &results {
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    }
    for (n, _) in &teams {
        let mut serials: Vec<i64> = results
            .iter()
            .map(|r| {
                r.body["opening"]["cards"].as_array().unwrap().iter().find(|c| c["num"] == *n).unwrap()["serial"]
                    .as_i64()
                    .unwrap()
            })
            .collect();
        serials.sort_unstable();
        let before = serials.len();
        serials.dedup();
        assert_eq!(serials.len(), before, "team {n}: every pull got its own serial");
    }
}

#[tokio::test]
async fn completing_a_division_awards_a_pack() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    let user = user_id(&db, &c).await;
    let recipe = recipe();
    let teams = recipe["teams"].as_array().unwrap();
    let div = teams[0]["div"].as_str().unwrap().to_string();
    let members: Vec<&Value> = teams.iter().filter(|t| t["div"] == div.as_str()).collect();
    // Own every team in the division but the last, then make the pack in hand contain the last one.
    for t in &members[..members.len() - 1] {
        give_card(&db, user, t["num"].as_i64().unwrap() as i32, t["tier"].as_str().unwrap()).await;
    }
    let last = members[members.len() - 1];
    let others: Vec<&Value> =
        teams.iter().filter(|t| t["div"] != div.as_str() && t["tier"] == "common").take(3).collect();
    let mut hand: Vec<Value> = others.iter().map(|t| json!({ "num": t["num"], "tier": "common" })).collect();
    // A first pack ends in Legendary or better, so the pack in hand has one (from another division) to be kept.
    let leg = teams.iter().find(|t| t["div"] != div.as_str() && t["tier"] == "legendary").unwrap();
    hand.push(json!({ "num": leg["num"], "tier": "legendary" }));
    hand.push(json!({ "num": last["num"], "tier": last["tier"] }));
    kit::rig_next(&db, user, PACK, &Value::Array(hand)).await;
    let o = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await;
    assert_eq!(o.status, StatusCode::OK, "{}", o.body);
    assert_eq!(o.body["opening"]["sets"], json!([div]), "the pack completes the {div} set");
    assert_eq!(sealed(&o.body["state"]), 2, "2 packs - 1 opened + 1 bonus");
    let col = call(&app, "GET", &format!("/api/collection/{PACK}"), Some(&c), None).await;
    assert_eq!(col.body["sets"], json!([div]));
}

/// Planted cards that the pack couldn't hold (wrong tiers, a team twice) are ignored, even with dev tools on.
#[tokio::test]
async fn a_tampered_rig_is_ignored() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    let user = user_id(&db, &c).await;
    let mythic = team_of("mythic", 0);
    let cheat = json!([
        { "num": mythic, "tier": "mythic" }, { "num": mythic, "tier": "mythic" }, { "num": mythic, "tier": "mythic" },
        { "num": mythic, "tier": "mythic" }, { "num": mythic, "tier": "mythic" }
    ]);
    kit::rig_next(&db, user, PACK, &cheat).await;
    let o = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await;
    assert_eq!(o.status, StatusCode::OK);
    let nums: std::collections::HashSet<i64> =
        o.body["opening"]["cards"].as_array().unwrap().iter().map(|c| c["num"].as_i64().unwrap()).collect();
    assert_eq!(nums.len(), 5, "no team twice: the forged cards weren't used");
    let common = team_of("common", 3);
    let wrong_tier =
        json!([1, 2, 3, 4, 5].iter().map(|_| json!({ "num": common, "tier": "mythic" })).collect::<Vec<_>>());
    kit::rig_next(&db, user, PACK, &wrong_tier).await;
    let o = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await;
    assert!(
        o.body["opening"]["cards"].as_array().unwrap().iter().all(|c| !(c["num"] == common && c["tier"] == "mythic")),
        "a common can't be made mythic"
    );
}

#[tokio::test]
async fn mythic_change_retiers_cards_and_pays_once() {
    let (app, db) = need_db!(setup(true));
    // 7769 was Mythic and is Legendary now; 4946 was Legendary and is Mythic now.
    let (c, _) = player(&app, &db).await;
    let me = kit::user_by_cookie(&db, &c).await;
    kit::give_card(&db, me, PACK, 7769, "mythic").await;
    kit::give_card(&db, me, PACK, 4946, "legendary").await;
    kit::change(&db, me, |p, _| p.retier = 0).await;
    let before = kit::parts(&db, me).await;

    let r = call(&app, "GET", "/api/state", Some(&c), None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.body["notice"].as_str().is_some_and(|n| n.contains("Mythics have changed")));
    assert_eq!(kit::parts(&db, me).await, before + 1000, "one lost Mythic, one payment");
    let tiers: Vec<(i32, String)> = kit::all_cards(&db, me, PACK).await.into_iter().map(|c| (c.team, c.tier)).collect();
    assert!(tiers.contains(&(7769, "legendary".into())) && tiers.contains(&(4946, "mythic".into())), "{tiers:?}");

    // Loading again (or signing in elsewhere) pays nothing more; the note goes once it's seen.
    call(&app, "GET", "/api/state", Some(&c), None).await;
    assert_eq!(kit::parts(&db, me).await, before + 1000);
    assert_eq!(call(&app, "POST", "/api/notice/seen", Some(&c), Some(json!({}))).await.status, StatusCode::NO_CONTENT);
    assert!(call(&app, "GET", "/api/state", Some(&c), None).await.body["notice"].is_null());

    // A player who never had a Mythic is brought up to date without parts or a note; new accounts start up to date.
    let (c2, state2) = player(&app, &db).await;
    assert!(state2["notice"].is_null());
    let other = kit::user_by_cookie(&db, &c2).await;
    kit::give_card(&db, other, PACK, 4946, "legendary").await;
    kit::change(&db, other, |p, _| p.retier = 0).await;
    let p2 = kit::parts(&db, other).await;
    assert!(call(&app, "GET", "/api/state", Some(&c2), None).await.body["notice"].is_null());
    assert_eq!(kit::parts(&db, other).await, p2);
    assert_eq!(kit::all_cards(&db, other, PACK).await[0].tier, "mythic");

    // A player already updated once (version 1) who holds 2491 as Mythic, from the typo: it quietly goes back to Rare,
    // and 2481 becomes Mythic, with no second payment.
    let (c3, _) = player(&app, &db).await;
    let third = kit::user_by_cookie(&db, &c3).await;
    kit::give_card(&db, third, PACK, 2491, "mythic").await;
    kit::give_card(&db, third, PACK, 2481, "legendary").await;
    kit::change(&db, third, |p, _| p.retier = 1).await;
    let p3 = kit::parts(&db, third).await;
    assert!(call(&app, "GET", "/api/state", Some(&c3), None).await.body["notice"].is_null());
    assert_eq!(kit::parts(&db, third).await, p3);
    let tiers: Vec<(i32, String)> =
        kit::all_cards(&db, third, PACK).await.into_iter().map(|c| (c.team, c.tier)).collect();
    assert!(tiers.contains(&(2491, "rare".into())) && tiers.contains(&(2481, "mythic".into())), "{tiers:?}");
}

#[tokio::test]
async fn admin_changes_rarities_without_a_deploy() {
    let (app, db) = need_db!(own_setup(false));
    let admin = make_admin(&app, &db).await;
    let (a, _) = player(&app, &db).await;
    let (b, _) = player(&app, &db).await;
    let (a_id, b_id) = (user_id(&db, &a).await, user_id(&db, &b).await);
    kit::give_card(&db, a_id, PACK, 1114, "mythic").await; // Mythic in the recipe file
    kit::give_card(&db, b_id, PACK, 7028, "legendary").await;
    let before = (kit::parts(&db, a_id).await, kit::parts(&db, b_id).await);

    let ov = call(&app, "GET", "/api/admin/tiers", Some(&admin), None).await;
    assert_eq!(ov.status, StatusCode::OK);
    assert_eq!(
        ov.body["teams"].as_array().unwrap().len(),
        recipe()["teams"].as_array().unwrap().len(),
        "every team in the pack"
    );
    assert!(call(&app, "GET", "/api/admin/tiers", Some(&a), None).await.status.is_client_error(), "admins only");

    // Preview: 1114 goes from Mythic to Legendary, 7028 up to Mythic; nothing is saved yet.
    let want = json!({ "tiers": { "1114": "legendary", "7028": "mythic" } });
    let pv = call(&app, "POST", "/api/admin/tiers/preview", Some(&admin), Some(want.clone())).await;
    assert_eq!(pv.body["changes"].as_array().unwrap().len(), 2, "{}", pv.body);
    assert_eq!(pv.body["mythicCopiesLost"], 1);
    assert!(pv.body["problem"].is_null());
    assert!(call(&app, "GET", "/api/state", Some(&a), None).await.body["tiers"].as_object().unwrap().is_empty());

    // Too few Mythics left is refused, with nothing saved.
    let few = call(&app, "POST", "/api/admin/tiers/apply", Some(&admin), Some(json!({ "tiers": { "4414": "legendary", "254": "legendary", "2910": "legendary", "1690": "legendary", "1678": "legendary", "1323": "legendary", "4946": "legendary", "2481": "legendary", "2056": "legendary", "1114": "legendary" }, "parts": 0, "note": "" }))).await;
    assert_eq!(few.status, StatusCode::BAD_REQUEST);

    // Apply with 500 parts and a note.
    let mut body = want.clone();
    body["parts"] = json!(500);
    body["note"] = json!("Rarities moved. Sorry!");
    assert_eq!(call(&app, "POST", "/api/admin/tiers/apply", Some(&admin), Some(body)).await.status, StatusCode::OK);

    // The player who lost a Mythic gets the parts and the note once; the one who gained one gets nothing.
    let sa = call(&app, "GET", "/api/state", Some(&a), None).await.body;
    assert_eq!(sa["notice"], "Rarities moved. Sorry!");
    assert_eq!(sa["tiers"]["1114"], "legendary");
    assert_eq!(sa["tiers"]["7028"], "mythic");
    assert_eq!(kit::parts(&db, a_id).await, before.0 + 500);
    assert!(call(&app, "GET", "/api/state", Some(&b), None).await.body["notice"].is_null());
    assert_eq!(kit::parts(&db, b_id).await, before.1);
    call(&app, "GET", "/api/state", Some(&a), None).await;
    assert_eq!(kit::parts(&db, a_id).await, before.0 + 500, "paid once");
    assert_eq!(kit::all_cards(&db, a_id, PACK).await[0].tier, "legendary");
    assert_eq!(kit::all_cards(&db, b_id, PACK).await[0].tier, "mythic");

    // Putting it back needs no payment (parts 0) and the overrides empty out.
    let back = call(
        &app,
        "POST",
        "/api/admin/tiers/apply",
        Some(&admin),
        Some(json!({ "tiers": {}, "parts": 0, "note": "" })),
    )
    .await;
    assert_eq!(back.status, StatusCode::OK);
    assert!(call(&app, "GET", "/api/state", Some(&a), None).await.body["tiers"].as_object().unwrap().is_empty());
    drop_table(&db).await;
}

#[tokio::test]
async fn writes_must_be_json() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    let r = call(&app, "POST", "/api/claim", Some(&c), None).await;
    assert_eq!(r.status, StatusCode::UNSUPPORTED_MEDIA_TYPE, "a cross-site form post can't open packs");
}

#[tokio::test]
async fn dev_tools_are_off_by_default() {
    let (app, db) = need_db!(setup(false));
    let (c, state) = player(&app, &db).await;
    assert_eq!(state["devTools"], false);
    for path in ["/api/dev/pack", "/api/dev/skip-timer", "/api/dev/reset", "/api/dev/invite"] {
        let r = call(&app, "POST", path, Some(&c), Some(json!({ "pack": PACK }))).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{path}");
    }
    let r = call(&app, "POST", "/api/dev/demo", Some(&c), Some(json!({ "on": true }))).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let teams: Vec<_> = (0..5).map(|i| team_of("mythic", i)).collect();
    let r = call(&app, "POST", "/api/dev/rig", Some(&c), Some(json!({ "pack": PACK, "teams": teams }))).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let o = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await;
    assert_eq!(o.status, StatusCode::OK, "{}", o.body);
    let opened: Vec<_> = o.body["opening"]["cards"].as_array().unwrap().iter().map(|c| c["num"].clone()).collect();
    assert!(teams.iter().any(|t| !opened.contains(&json!(t))), "the refused rig didn't plant anything");
}

/// The browser tests plant their next pack; only five different teams from that pack are accepted.
#[tokio::test]
async fn dev_rig_plants_the_next_pack() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    let teams: Vec<_> = (0..5).map(|i| team_of("common", i)).collect();
    for bad in [
        json!(teams[..4]),
        json!([teams[0], teams[0], teams[1], teams[2], teams[3]]),
        json!([teams[0], teams[1], teams[2], teams[3], -1]),
    ] {
        let r = call(&app, "POST", "/api/dev/rig", Some(&c), Some(json!({ "pack": PACK, "teams": bad }))).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    let r = call(&app, "POST", "/api/dev/rig", Some(&c), Some(json!({ "pack": PACK, "teams": teams }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let o = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await;
    assert_eq!(o.status, StatusCode::OK, "{}", o.body);
    let opened: Vec<_> = o.body["opening"]["cards"].as_array().unwrap().iter().map(|c| c["num"].clone()).collect();
    assert_eq!(opened.len(), 5);
    assert!(teams.iter().all(|t| opened.contains(&json!(t))), "{opened:?}");
}

#[tokio::test]
async fn health_check_reaches_the_database() {
    let (app, _db) = need_db!(setup(false));
    let r = call(&app, "GET", "/api/health", None, None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body, json!({ "ok": true }));
}

#[tokio::test]
async fn cache_headers_suit_a_cdn() {
    let Some(db) = table("frc-packs-test").await else { return };
    let web = std::env::temp_dir().join(format!("frc-web-{}", Uuid::new_v4()));
    std::fs::create_dir_all(web.join("assets")).unwrap();
    std::fs::write(web.join("index.html"), "<!doctype html>").unwrap();
    std::fs::write(web.join("assets/app-abc123.js"), "1").unwrap();
    let data_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../data");
    let app = app(
        db,
        Config { data_dir, web_dir: Some(web.clone()), dev_tools: false, cookie_secure: true, admin_only: false },
    )
    .unwrap();
    let cache = |path: &'static str| {
        let app = app.clone();
        async move {
            let res = app.oneshot(Request::get(path).body(Body::empty()).unwrap()).await.unwrap();
            let cc = res.headers().get(header::CACHE_CONTROL).map(|v| v.to_str().unwrap().to_string());
            (res.status(), cc)
        }
    };
    let expect = [
        ("/", StatusCode::OK, Some("no-cache")),
        ("/some/page", StatusCode::OK, Some("no-cache")),
        ("/assets/app-abc123.js", StatusCode::OK, Some("public, max-age=31536000, immutable")),
        ("/assets/missing.js", StatusCode::NOT_FOUND, None),
        ("/packs/cmp26.json", StatusCode::OK, Some("no-cache")),
        ("/photos/254.webp", StatusCode::OK, Some("public, max-age=86400")),
        ("/api/health", StatusCode::OK, Some("no-store")),
        ("/api/state", StatusCode::UNAUTHORIZED, Some("no-store")),
    ];
    for (path, status, cc) in expect {
        assert_eq!(cache(path).await, (status, cc.map(str::to_string)), "{path}");
    }
    std::fs::remove_dir_all(web).ok();
}

#[tokio::test]
async fn invite_codes_make_accounts() {
    let (app, db) = need_db!(setup(false));
    let code = kit::invite(&db, 1).await;
    let signup = |code: String, username: String, password: &'static str| {
        let app = app.clone();
        async move {
            call(
                &app,
                "POST",
                "/api/signup",
                None,
                Some(json!({ "code": code, "username": username, "password": password, "firstName": "Test" })),
            )
            .await
        }
    };
    let bad = signup("ZZZZ-ZZZZ-ZZZZ".into(), name(), "longenough").await;
    assert_eq!((bad.status, bad.body["error"].as_str()), (StatusCode::BAD_REQUEST, Some("bad_invite")));
    let short = signup(code.clone(), name(), "short").await;
    assert_eq!(short.body["error"], "bad_password");
    let spaces = signup(code.clone(), "has space".into(), "longenough").await;
    assert_eq!(spaces.body["error"], "bad_username");

    let who = name();
    // Codes can be typed in lower case and without dashes.
    let ok = signup(code.to_lowercase().replace('-', ""), who.clone(), "longenough").await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    assert_eq!(ok.body["account"]["username"], who.as_str());
    assert_eq!(sealed(&ok.body), 2);
    let used = signup(code, name(), "longenough").await;
    assert_eq!(used.body["error"], "invite_used", "a single-use code works once");

    let team = kit::invite(&db, 3).await;
    for _ in 0..3 {
        assert_eq!(signup(team.clone(), name(), "longenough").await.status, StatusCode::OK);
    }
    assert_eq!(signup(team, name(), "longenough").await.body["error"], "invite_used");

    let taken = signup(kit::invite(&db, 1).await, who.to_uppercase(), "longenough").await;
    assert_eq!((taken.status, taken.body["error"].as_str()), (StatusCode::CONFLICT, Some("username_taken")));
}

/// Ten people racing for a code's last two uses: exactly two accounts are made. And two people racing for one
/// username: one gets it.
#[tokio::test]
async fn invite_limits_and_usernames_hold_under_a_race() {
    let (app, db) = need_db!(setup(false));
    let code = kit::invite(&db, 2).await;
    let jobs: Vec<_> = (0..10)
        .map(|_| {
            let (app, code) = (app.clone(), code.clone());
            async move {
                call(
                    &app,
                    "POST",
                    "/api/signup",
                    None,
                    Some(json!({ "code": code, "username": name(), "password": "hunter22!", "firstName": "Racer" })),
                )
                .await
            }
        })
        .collect();
    let rs = futures_join(jobs).await;
    assert_eq!(rs.iter().filter(|r| r.status == StatusCode::OK).count(), 2, "a 2-use code makes 2 accounts");
    assert!(rs.iter().all(|r| r.status.as_u16() < 500));
    let who = name();
    let jobs: Vec<_> = (0..6)
        .map(|i| {
            let (app, db, who) = (app.clone(), db.clone(), if i % 2 == 0 { who.clone() } else { who.to_uppercase() });
            async move {
                let code = kit::invite(&db, 1).await;
                call(
                    &app,
                    "POST",
                    "/api/signup",
                    None,
                    Some(json!({ "code": code, "username": who, "password": "hunter22!", "firstName": "Racer" })),
                )
                .await
            }
        })
        .collect();
    let rs = futures_join(jobs).await;
    assert_eq!(
        rs.iter().filter(|r| r.status == StatusCode::OK).count(),
        1,
        "one username, one account, whatever the case"
    );
}

#[tokio::test]
async fn sign_in_on_another_device_and_out() {
    let (app, db) = need_db!(setup(false));
    let (who, phone, _) = signup(&app, &db, &name()).await;
    let login = |username: String, password: &'static str| {
        let app = app.clone();
        async move {
            call(&app, "POST", "/api/login", None, Some(json!({ "username": username, "password": password }))).await
        }
    };
    let wrong = login(who.clone(), "nope-nope").await;
    assert_eq!((wrong.status, wrong.body["error"].as_str()), (StatusCode::UNAUTHORIZED, Some("bad_login")));
    let nobody = login(name(), "hunter22!").await;
    assert_eq!(nobody.body["error"], "bad_login", "unknown names look the same as wrong passwords");

    // No invite code needed to sign in, in any case.
    let laptop = login(who.to_uppercase(), "hunter22!").await;
    assert_eq!(laptop.status, StatusCode::OK);
    let laptop = laptop.cookie.unwrap();
    assert_ne!(laptop, phone);
    for c in [&phone, &laptop] {
        assert_eq!(
            call(&app, "GET", "/api/state", Some(c), None).await.status,
            StatusCode::OK,
            "both devices stay signed in"
        );
    }
    let out = call(&app, "POST", "/api/logout", Some(&phone), Some(json!({}))).await;
    assert_eq!(out.status, StatusCode::NO_CONTENT);
    assert_eq!(out.cookie.as_deref(), Some("sid="), "the cookie is cleared");
    assert_eq!(call(&app, "GET", "/api/state", Some(&phone), None).await.status, StatusCode::UNAUTHORIZED);
    assert_eq!(call(&app, "GET", "/api/state", Some(&laptop), None).await.status, StatusCode::OK);
}

#[tokio::test]
async fn guessing_passwords_gets_blocked() {
    let (app, db) = need_db!(setup(false));
    let (who, _, _) = signup(&app, &db, &name()).await;
    for _ in 0..10 {
        let r = call(&app, "POST", "/api/login", None, Some(json!({ "username": who, "password": "guessing" }))).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    }
    let r = call(&app, "POST", "/api/login", None, Some(json!({ "username": who, "password": "hunter22!" }))).await;
    assert_eq!((r.status, r.body["error"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_many_attempts")));
}

#[tokio::test]
async fn change_password_signs_out_other_devices() {
    let (app, db) = need_db!(setup(false));
    let (who, phone, _) = signup(&app, &db, &name()).await;
    let laptop =
        call(&app, "POST", "/api/login", None, Some(json!({ "username": who, "password": "hunter22!" }))).await;
    let laptop = laptop.cookie.unwrap();
    // The sessions index catches up a moment after a sign-in.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let wrong = call(
        &app,
        "POST",
        "/api/password",
        Some(&phone),
        Some(json!({ "current": "nope-nope", "new": "brand-new-pw" })),
    )
    .await;
    assert_eq!(wrong.status, StatusCode::UNAUTHORIZED);
    let ok = call(
        &app,
        "POST",
        "/api/password",
        Some(&phone),
        Some(json!({ "current": "hunter22!", "new": "brand-new-pw" })),
    )
    .await;
    assert_eq!(ok.status, StatusCode::NO_CONTENT);
    assert_eq!(call(&app, "GET", "/api/state", Some(&phone), None).await.status, StatusCode::OK);
    assert_eq!(call(&app, "GET", "/api/state", Some(&laptop), None).await.status, StatusCode::UNAUTHORIZED);
    let old = call(&app, "POST", "/api/login", None, Some(json!({ "username": who, "password": "hunter22!" }))).await;
    assert_eq!(old.status, StatusCode::UNAUTHORIZED);
    let new =
        call(&app, "POST", "/api/login", None, Some(json!({ "username": who, "password": "brand-new-pw" }))).await;
    assert_eq!(new.status, StatusCode::OK);
}

#[tokio::test]
async fn only_the_admin_can_use_the_panel() {
    let (app, db) = need_db!(setup(false));
    let (player_cookie, _) = player(&app, &db).await;
    for (method, path) in [
        ("GET", "/api/admin/users"),
        ("GET", "/api/admin/invites"),
        ("POST", "/api/admin/invites"),
        ("GET", "/api/admin/audit"),
    ] {
        let body = (method == "POST").then(|| json!({ "uses": 1, "count": 1 }));
        assert_eq!(
            call(&app, method, path, Some(&player_cookie), body.clone()).await.status,
            StatusCode::FORBIDDEN,
            "{path}"
        );
        assert_eq!(call(&app, method, path, None, body).await.status, StatusCode::UNAUTHORIZED, "{path}");
    }
    let admin = make_admin(&app, &db).await;
    let state = call(&app, "GET", "/api/state", Some(&admin), None).await;
    assert_eq!(state.body["account"]["admin"], true);
    assert_eq!(call(&app, "GET", "/api/admin/users", Some(&admin), None).await.status, StatusCode::OK);
}

/// Admins can't hand out packs: every pack comes from a rule the game enforces (timer, craft, streak, set, feedback).
#[tokio::test]
async fn admins_cannot_give_packs() {
    let (app, db) = need_db!(setup(false));
    let (c, _) = player(&app, &db).await;
    let target = user_id(&db, &c).await;
    let before = sealed(&call(&app, "GET", "/api/state", Some(&c), None).await.body);
    let admin = make_admin(&app, &db).await;
    let r = call(&app, "POST", &format!("/api/admin/users/{target}/packs"), Some(&admin), Some(json!({ "count": 50 })))
        .await;
    assert!(
        r.status == StatusCode::NOT_FOUND || r.status == StatusCode::METHOD_NOT_ALLOWED,
        "gift route gone, got {}",
        r.status
    );
    assert_eq!(sealed(&call(&app, "GET", "/api/state", Some(&c), None).await.body), before);
}

/// While the site is admin-only (testing on the real domain), nobody else gets in: no sign-up, no sign-in, and an
/// existing player's session stops working.
#[tokio::test]
async fn admin_only_mode_keeps_everyone_else_out() {
    let (open_app, db) = need_db!(setup(false));
    let (who, player_cookie, _) = signup(&open_app, &db, &name()).await;
    let admin = make_admin(&open_app, &db).await;
    let app = router(&db, false, true);
    let r = call(&app, "POST", "/api/login", None, Some(json!({ "username": who, "password": "hunter22!" }))).await;
    assert_eq!((r.status, r.body["error"].as_str()), (StatusCode::FORBIDDEN, Some("admin_only")));
    let code = kit::invite(&db, 1).await;
    let r = call(
        &app,
        "POST",
        "/api/signup",
        None,
        Some(json!({ "code": code, "username": name(), "password": "hunter22!", "firstName": "X" })),
    )
    .await;
    assert_eq!(r.body["error"], "admin_only");
    for path in ["/api/state", "/api/trades"] {
        assert_eq!(call(&app, "GET", path, Some(&player_cookie), None).await.status, StatusCode::FORBIDDEN, "{path}");
    }
    assert_eq!(
        call(&app, "POST", "/api/open", Some(&player_cookie), Some(json!({ "pack": PACK }))).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&app, "GET", "/api/state", Some(&admin), None).await.status,
        StatusCode::OK,
        "the admin plays as usual"
    );
    assert_eq!(
        call(&app, "POST", "/api/open", Some(&admin), Some(json!({ "pack": PACK }))).await.status,
        StatusCode::OK
    );
}

#[tokio::test]
async fn admin_makes_invite_codes() {
    let (app, db) = need_db!(setup(false));
    let admin = make_admin(&app, &db).await;
    let note = format!("team {}", name());
    let r =
        call(&app, "POST", "/api/admin/invites", Some(&admin), Some(json!({ "note": note, "uses": 5, "count": 3 })))
            .await;
    assert_eq!(r.status, StatusCode::OK);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let r = call(&app, "GET", "/api/admin/invites", Some(&admin), None).await;
    let mine: Vec<&Value> = r.body.as_array().unwrap().iter().filter(|i| i["note"] == note.as_str()).collect();
    assert_eq!(mine.len(), 3);
    assert!(mine.iter().all(|i| i["maxUses"] == 5 && i["uses"] == 0));
    let code = mine[0]["code"].as_str().unwrap().to_string();
    assert_eq!(code.len(), 14, "shown as XXXX-XXXX-XXXX");

    let who = name();
    let r = call(
        &app,
        "POST",
        "/api/signup",
        None,
        Some(json!({ "code": code, "username": who, "password": "hunter22!", "firstName": "Test" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let list = call(&app, "GET", "/api/admin/invites", Some(&admin), None).await.body;
    let used = list.as_array().unwrap().iter().find(|i| i["code"] == code.as_str()).unwrap();
    assert_eq!((used["uses"].as_i64(), used["usedBy"].clone()), (Some(1), json!([who])));
    let users = call(&app, "GET", "/api/admin/users", Some(&admin), None).await.body;
    let u = users.as_array().unwrap().iter().find(|u| u["username"] == who.as_str()).unwrap();
    assert_eq!((u["invite"].as_str(), u["inviteNote"].as_str()), (Some(code.as_str()), Some(note.as_str())));

    let bad = call(&app, "POST", "/api/admin/invites", Some(&admin), Some(json!({ "uses": 0, "count": 1 }))).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST);
    let del = call(&app, "POST", &format!("/api/admin/invites/{code}/delete"), Some(&admin), Some(json!({}))).await;
    assert_eq!(del.status, StatusCode::NO_CONTENT);
    let r = call(
        &app,
        "POST",
        "/api/signup",
        None,
        Some(json!({ "code": code, "username": name(), "password": "hunter22!", "firstName": "Test" })),
    )
    .await;
    assert_eq!(r.body["error"], "bad_invite", "a deleted code no longer works");
}

#[tokio::test]
async fn admin_manages_accounts() {
    let (app, db) = need_db!(setup(false));
    let admin = make_admin(&app, &db).await;
    let (who, cookie, _) = signup(&app, &db, &name()).await;
    let id = user_id(&db, &cookie).await;
    let at = |what: &str| format!("/api/admin/users/{id}/{what}");

    // Reset password: the old one stops working, the new one is shown once, and they're signed out.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let r = call(&app, "POST", &at("password"), Some(&admin), Some(json!({}))).await;
    let password = r.body["password"].as_str().unwrap().to_string();
    assert_eq!(call(&app, "GET", "/api/state", Some(&cookie), None).await.status, StatusCode::UNAUTHORIZED);
    let login = |pw: String| {
        let app = app.clone();
        let who = who.clone();
        async move { call(&app, "POST", "/api/login", None, Some(json!({ "username": who, "password": pw }))).await }
    };
    assert_eq!(login("hunter22!".into()).await.status, StatusCode::UNAUTHORIZED);
    let back = login(password.clone()).await;
    assert_eq!(back.status, StatusCode::OK);

    // Disable: signed out and can't sign in; enable: can again.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let off = call(&app, "POST", &at("disabled"), Some(&admin), Some(json!({ "disabled": true }))).await;
    assert_eq!(off.status, StatusCode::NO_CONTENT);
    assert_eq!(
        call(&app, "GET", "/api/state", Some(&back.cookie.unwrap()), None).await.status,
        StatusCode::UNAUTHORIZED
    );
    let r = login(password.clone()).await;
    assert_eq!((r.status, r.body["error"].as_str()), (StatusCode::FORBIDDEN, Some("disabled")));
    call(&app, "POST", &at("disabled"), Some(&admin), Some(json!({ "disabled": false }))).await;
    assert_eq!(login(password.clone()).await.status, StatusCode::OK);

    // Delete needs the username typed again.
    let r = call(&app, "POST", &at("delete"), Some(&admin), Some(json!({ "confirm": "someone-else" }))).await;
    assert_eq!(r.body["error"], "confirm_mismatch");
    let r = call(&app, "POST", &at("delete"), Some(&admin), Some(json!({ "confirm": who }))).await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    assert_eq!(login(password).await.body["error"], "bad_login");
    assert!(!kit::exists(&db, id).await);

    // The admin can't lock themself out from the panel.
    let me = user_id(&db, &admin).await;
    for what in ["disabled", "delete", "password"] {
        let r = call(
            &app,
            "POST",
            &format!("/api/admin/users/{me}/{what}"),
            Some(&admin),
            Some(json!({ "disabled": true, "confirm": "x" })),
        )
        .await;
        assert_eq!(r.body["error"], "not_yourself", "{what}");
    }
}

#[tokio::test]
async fn create_admin_once_and_reset_by_name() {
    // A table of its own, so "no admin yet" is true no matter what other tests did.
    let Some(db) = table(&format!("frc-admin-{}", Uuid::new_v4().simple())).await else { return };
    let (name, password) = frc_packs_server::admin::create_admin(&db, "admin", PACK).await.unwrap();
    let password = password.expect("a new admin gets a password");
    assert_eq!((name.as_str(), password.len()), ("admin", 19));
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let again = frc_packs_server::admin::create_admin(&db, "someone", PACK).await.unwrap();
    assert_eq!(again, ("admin".to_string(), None), "only one admin is made");

    let app = router(&db, false, false);
    let r = call(&app, "POST", "/api/login", None, Some(json!({ "username": "admin", "password": password }))).await;
    assert_eq!((r.status, r.body["account"]["admin"].as_bool()), (StatusCode::OK, Some(true)));
    assert_eq!(sealed(&r.body), 2);

    let new = frc_packs_server::admin::reset_password_by_name(&db, "ADMIN").await.unwrap();
    let r = call(&app, "POST", "/api/login", None, Some(json!({ "username": "admin", "password": new }))).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(frc_packs_server::admin::reset_password_by_name(&db, "nobody").await.is_err());
    db.client.delete_table().table_name(&db.table).send().await.ok();
}

#[tokio::test]
async fn admin_sees_and_checks_the_free_pack_rules() {
    let (app, db) = need_db!(setup(true));
    let (player_cookie, _) = player(&app, &db).await;
    assert_eq!(
        call(&app, "GET", "/api/admin/settings", Some(&player_cookie), None).await.status,
        StatusCode::FORBIDDEN
    );
    let admin = make_admin(&app, &db).await;
    let got = call(&app, "GET", "/api/admin/settings", Some(&admin), None).await;
    assert_eq!(got.status, StatusCode::OK);
    for k in ["claimMinutes", "claimPacks", "bank", "startPacks", "boostCost"] {
        assert!(got.body[k].is_i64(), "{k} in {}", got.body);
    }
    // Saving the same rules back changes nothing for the other tests sharing this table.
    let same = call(&app, "POST", "/api/admin/settings", Some(&admin), Some(got.body.clone())).await;
    assert_eq!((same.status, &same.body), (StatusCode::OK, &got.body));
    for bad in
        [json!({ "claimMinutes": 0 }), json!({ "claimPacks": 21 }), json!({ "bank": 0 }), json!({ "startPacks": 51 })]
    {
        let mut body = got.body.clone();
        body.as_object_mut().unwrap().extend(bad.as_object().unwrap().clone());
        let r = call(&app, "POST", "/api/admin/settings", Some(&admin), Some(body)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{bad}");
    }
    let st = call(&app, "GET", "/api/state", Some(&admin), None).await.body;
    assert_eq!(st["claimMs"].as_i64().unwrap(), got.body["claimMinutes"].as_i64().unwrap() * 60_000);
    assert_eq!(st["claimPacks"], got.body["claimPacks"]);
}

#[tokio::test]
async fn scrap_extras_for_parts_and_craft_a_boosted_pack() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    let id = user_id(&db, &c).await;
    // Three copies of a Common and two of a Rare.
    let common: i32 = team_of("common", 101);
    let rare: i32 = team_of("rare", 88);
    let mut first_serial = 0;
    for (team, tier, n) in [(common, "common", 3), (rare, "rare", 2)] {
        for k in 0..n {
            let s = give_card(&db, id, team, tier).await;
            if team == common && k == 0 {
                first_serial = s;
            }
        }
    }
    // Scrap needs a real team in the pack.
    let r = call(&app, "POST", "/api/scrap", Some(&c), Some(json!({ "pack": PACK, "num": 99_999, "count": 5 }))).await;
    assert_eq!((r.status, r.body["error"].as_str()), (StatusCode::NOT_FOUND, Some("unknown_team")));
    // Scrap all extra Commons and Rares: 2 Commons (5 each) and 1 Rare (40).
    let r =
        call(&app, "POST", "/api/scrap/extras", Some(&c), Some(json!({ "pack": PACK, "tiers": ["common", "rare"] })))
            .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!((r.body["gained"].as_i64(), r.body["scrapped"].as_i64()), (Some(50), Some(3)));
    assert_eq!(r.body["state"]["parts"], 50);
    let kept = r.body["collection"]["cards"].as_array().unwrap().iter().find(|x| x["num"] == common).unwrap().clone();
    assert_eq!(kept["serials"], json!([first_serial]), "the first copy is kept");
    let again =
        call(&app, "POST", "/api/scrap/extras", Some(&c), Some(json!({ "pack": PACK, "tiers": ["common", "rare"] })))
            .await;
    assert_eq!(again.body["scrapped"], 0, "nothing left to scrap");

    let cost = call(&app, "GET", "/api/state", Some(&c), None).await.body["boostCost"].as_i64().unwrap();
    let r = call(&app, "POST", "/api/craft", Some(&c), Some(json!({}))).await;
    assert_eq!((r.status, r.body["error"].as_str()), (StatusCode::CONFLICT, Some("not_enough_parts")));
    kit::set_parts(&db, id, cost).await;
    let r = call(&app, "POST", "/api/craft", Some(&c), Some(json!({}))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["parts"], 0);
    let p = r.body["packs"].as_array().unwrap().iter().find(|p| p["id"] == PACK).unwrap();
    assert_eq!((p["sealed"].as_i64(), p["boosted"].as_i64()), (Some(3), Some(1)));
    let o = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await;
    assert_eq!(o.status, StatusCode::OK);
    assert_eq!(o.body["opening"]["boosted"], true, "boosted packs open first");
    let p = o.body["state"]["packs"].as_array().unwrap().iter().find(|p| p["id"] == PACK).unwrap();
    assert_eq!(p["boosted"], 0);
    assert!(kit::last_opening_boosted(&db, id).await, "the opening is recorded as boosted");
}

/// Crafting with parts for exactly one pack, ten times at once: one pack, parts spent once, never below zero.
#[tokio::test]
async fn simultaneous_crafts_never_overspend() {
    let (app, db) = need_db!(setup(true));
    let (c, st) = player(&app, &db).await;
    let id = user_id(&db, &c).await;
    let cost = st["boostCost"].as_i64().unwrap();
    kit::set_parts(&db, id, cost).await;
    let jobs: Vec<_> = (0..10)
        .map(|_| {
            let (app, c) = (app.clone(), c.clone());
            async move { call(&app, "POST", "/api/craft", Some(&c), Some(json!({}))).await }
        })
        .collect();
    let rs = futures_join(jobs).await;
    assert_eq!(rs.iter().filter(|r| r.status == StatusCode::OK).count(), 1, "one craft");
    assert!(rs.iter().all(|r| r.status.as_u16() < 500));
    assert_eq!(kit::parts(&db, id).await, 0);
    assert_eq!(kit::packs(&db, id, PACK).await.boosted, 1);
}

#[tokio::test]
async fn trading_swaps_the_exact_copies() {
    let (app, db) = need_db!(setup(true));
    let (ca, _) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let (a, b) = (user_id(&db, &ca).await, user_id(&db, &cb).await);
    age(&db, &[a, b]).await; // past the new-account rule: brand-new accounts can't give cards
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    let (x, y) = (team_of("common", 77), team_of("rare", 55));
    let x_first = give_card(&db, a, x, "common").await;
    let x_newest = give_card(&db, a, x, "common").await;
    let y_serial = give_card(&db, b, y, "rare").await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let found = call(&app, "GET", &format!("/api/players?q={}", &b_name[..6]), Some(&ca), None).await;
    assert!(found.body.as_array().unwrap().iter().any(|n| n == b_name.as_str()), "{}", found.body);
    let theirs = call(&app, "GET", &format!("/api/players/{b_name}/collection/{PACK}"), Some(&ca), None).await;
    assert!(theirs.body["cards"].as_array().unwrap().iter().any(|c| c["num"] == y));

    let bad = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [x], "want": [x] })),
    )
    .await;
    assert_eq!(
        (bad.status, bad.body["error"].as_str()),
        (StatusCode::CONFLICT, Some("not_owned")),
        "they don't have x"
    );
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [x], "want": [y] })),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["outgoing"][0]["youGive"][0]["serial"], x_newest, "the newest copy is offered");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // A promised copy can't be scrapped out from under the offer.
    let s =
        call(&app, "POST", "/api/scrap/extras", Some(&ca), Some(json!({ "pack": PACK, "tiers": ["common"] }))).await;
    assert_eq!(s.body["scrapped"], 0, "{}", s.body);

    let inbox = call(&app, "GET", "/api/trades", Some(&cb), None).await.body;
    let t = &inbox["incoming"][0];
    assert_eq!(
        (t["youGive"][0]["num"].as_i64(), t["youGet"][0]["num"].as_i64()),
        (Some(i64::from(y)), Some(i64::from(x)))
    );
    let id = t["id"].as_i64().unwrap();
    let not_mine = call(&app, "POST", &format!("/api/trades/{id}/accept"), Some(&ca), Some(json!({}))).await;
    assert_eq!(not_mine.status, StatusCode::FORBIDDEN, "only the other player can accept");
    let ok = call(&app, "POST", &format!("/api/trades/{id}/accept"), Some(&cb), Some(json!({}))).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    assert_eq!(kit::owners_of(&db, PACK, x, x_newest).await, vec![b], "B has A's newest copy, serial and all");
    assert_eq!(kit::owners_of(&db, PACK, x, x_first).await, vec![a], "A keeps the first copy");
    assert_eq!(kit::owners_of(&db, PACK, y, y_serial).await, vec![a]);
    let again = call(&app, "POST", &format!("/api/trades/{id}/accept"), Some(&cb), Some(json!({}))).await;
    assert_eq!(again.status, StatusCode::NOT_FOUND);

    // Decline and cancel.
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [y], "want": [x] })),
    )
    .await;
    let id = r.body["outgoing"][0]["id"].as_i64().unwrap();
    let d = call(&app, "POST", &format!("/api/trades/{id}/decline"), Some(&cb), Some(json!({}))).await;
    assert_eq!(d.body["recent"][0]["status"], "declined");
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [y], "want": [x] })),
    )
    .await;
    let id = r.body["outgoing"][0]["id"].as_i64().unwrap();
    assert_eq!(
        call(&app, "POST", &format!("/api/trades/{id}/cancel"), Some(&cb), Some(json!({}))).await.status,
        StatusCode::FORBIDDEN
    );
    let c = call(&app, "POST", &format!("/api/trades/{id}/cancel"), Some(&ca), Some(json!({}))).await;
    assert_eq!(
        (c.body["outgoing"].as_array().unwrap().len(), c.body["recent"][0]["status"].as_str()),
        (0, Some("cancelled"))
    );
}

/// Trading can't duplicate a card: twenty simultaneous accepts of one offer swap it once, two offers asking for the
/// same card can't both go through, and scrapping at the same time never touches a card in an offer.
#[tokio::test]
async fn trades_never_duplicate_cards() {
    let (app, db) = need_db!(setup(true));
    let (ca, _) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let (cc, _) = player(&app, &db).await;
    let (a, b, c) = (user_id(&db, &ca).await, user_id(&db, &cb).await, user_id(&db, &cc).await);
    age(&db, &[a, b, c]).await; // past the new-account rule: brand-new accounts can't give cards
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    let (x, y, z) = (team_of("common", 120), team_of("uncommon", 120), team_of("common", 121));
    give_card(&db, a, x, "common").await;
    give_card(&db, b, y, "uncommon").await;
    let y_newest = give_card(&db, b, y, "uncommon").await; // B has two copies of y, so scrapping has something to try
    give_card(&db, c, z, "common").await;
    let total = || {
        let db = db.clone();
        async move {
            let mut n = 0;
            for u in [a, b, c] {
                n += kit::all_cards(&db, u, PACK).await.iter().filter(|c| [x, y, z].contains(&c.team)).count() as i64;
            }
            n
        }
    };
    let before = total().await;

    // A and C both ask B for the same (newest) copy of y.
    let ra = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [x], "want": [y] })),
    )
    .await;
    let rc = call(
        &app,
        "POST",
        "/api/trades",
        Some(&cc),
        Some(json!({ "to": b_name, "pack": PACK, "give": [z], "want": [y] })),
    )
    .await;
    let (ta, tc) = (ra.body["outgoing"][0]["id"].as_i64().unwrap(), rc.body["outgoing"][0]["id"].as_i64().unwrap());
    assert_eq!(
        ra.body["outgoing"][0]["youGet"][0]["serial"], rc.body["outgoing"][0]["youGet"][0]["serial"],
        "both want the same copy"
    );
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // B accepts both, twenty times each, all at once, while also scrapping.
    let mut jobs = Vec::new();
    for i in 0..40 {
        let (app, cb) = (app.clone(), cb.clone());
        let id = if i % 2 == 0 { ta } else { tc };
        jobs.push(tokio::spawn(async move {
            call(&app, "POST", &format!("/api/trades/{id}/accept"), Some(&cb), Some(json!({}))).await.status
        }));
    }
    for _ in 0..5 {
        let (app, cb) = (app.clone(), cb.clone());
        jobs.push(tokio::spawn(async move {
            call(&app, "POST", "/api/scrap/extras", Some(&cb), Some(json!({ "pack": PACK, "tiers": ["uncommon"] })))
                .await
                .status
        }));
    }
    let mut ok = 0;
    for j in jobs {
        let st = j.await.unwrap();
        assert!(st != StatusCode::INTERNAL_SERVER_ERROR, "no request may fail with a server error");
        if st == StatusCode::OK {
            ok += 1;
        }
    }
    assert!(ok >= 1);
    let accepted = [kit::trade_status(&db, ta).await, kit::trade_status(&db, tc).await]
        .iter()
        .filter(|s| *s == "accepted")
        .count();
    assert!(accepted <= 1, "only one of two offers for the same card can go through");
    assert!(kit::owners_of(&db, PACK, y, y_newest).await.len() <= 1, "a serial exists at most once");
    let after = total().await;
    let scrapped = kit::parts(&db, b).await;
    // Cards only ever move or get scrapped; nothing is created by trading.
    assert!(after <= before, "trading created cards: {before} -> {after}");
    assert_eq!(before - after, scrapped / 12, "every card that left was scrapped for parts, none vanished");
}

/// Cards in a pack still being revealed can't be offered, and can't change hands even if an offer named them.
#[tokio::test]
async fn cards_mid_reveal_cannot_be_traded_or_scrapped() {
    let (app, db) = need_db!(setup(true));
    let (ca, _) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let a = user_id(&db, &ca).await;
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    let team = team_of("common", 135);
    let hand = json!([
        { "num": team, "tier": "common" }, { "num": team_of("common", 136), "tier": "common" }, { "num": team_of("common", 137), "tier": "common" },
        { "num": team_of("common", 138), "tier": "common" }, { "num": team_of("legendary", 41), "tier": "legendary" }
    ]);
    give_card(&db, a, team, "common").await; // an older copy, free to trade
    age(&db, &[a, user_id(&db, &cb).await]).await;
    kit::rig_next(&db, a, PACK, &hand).await;
    let o = call(&app, "POST", "/api/open", Some(&ca), Some(json!({ "pack": PACK }))).await;
    assert_eq!(o.status, StatusCode::OK, "{}", o.body);
    let opened_serial =
        o.body["opening"]["cards"].as_array().unwrap().iter().find(|c| c["num"] == team).unwrap()["serial"]
            .as_i64()
            .unwrap();
    // Asking for the copy from the unrevealed pack by serial: refused.
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [team], "giveSerials": [opened_serial], "wantPacks": 1 })),
    )
    .await;
    assert_eq!(r.body["error"], "card_held", "a card still being revealed can't be offered, and says so");
    // Scrapping skips it too.
    let s = call(&app, "POST", "/api/scrap", Some(&ca), Some(json!({ "pack": PACK, "num": team, "count": 1 }))).await;
    assert_eq!(s.body["error"], "extras_held", "{}", s.body);
    // Once revealed, it's an ordinary card.
    let id = o.body["opening"]["id"].as_i64().unwrap();
    call(&app, "POST", &format!("/api/openings/{id}/progress"), Some(&ca), Some(json!({ "revealed": 5 }))).await;
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [team], "giveSerials": [opened_serial], "wantPacks": 1 })),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let _ = cb;
}

/// An offer whose cards are gone by the time it's accepted fails, and nothing moves.
#[tokio::test]
async fn an_offer_for_cards_that_left_fails_cleanly() {
    let (app, db) = need_db!(setup(true));
    let (ca, _) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let (a, b) = (user_id(&db, &ca).await, user_id(&db, &cb).await);
    age(&db, &[a, b]).await; // past the new-account rule: brand-new accounts can't give cards
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    let (x, y) = (team_of("common", 132), team_of("common", 133));
    give_card(&db, a, x, "common").await;
    let y_serial = give_card(&db, b, y, "common").await;
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [x], "want": [y] })),
    )
    .await;
    let id = r.body["outgoing"][0]["id"].as_i64().unwrap();
    // A's card leaves (scrapped elsewhere, say) before B accepts.
    kit::remove_team(&db, a, PACK, x).await;
    let r = call(&app, "POST", &format!("/api/trades/{id}/accept"), Some(&cb), Some(json!({}))).await;
    assert_eq!(r.body["error"], "trade_stale");
    assert_eq!(kit::trade_status(&db, id).await, "failed");
    assert_eq!(kit::owners_of(&db, PACK, y, y_serial).await, vec![b], "B kept their card");
    assert_eq!(kit::count_cards(&db, b, PACK, x).await, 0, "B got nothing");
}

#[tokio::test]
async fn daily_missions_and_streak() {
    let (app, db) = need_db!(setup(true));
    let (c, st) = player(&app, &db).await;
    let id = user_id(&db, &c).await;
    let m = |st: &Value, id: &str| st["missions"].as_array().unwrap().iter().find(|m| m["id"] == id).unwrap().clone();
    // Three missions a day, of different kinds, drawn from a bigger pool.
    let todays = st["missions"].as_array().unwrap();
    assert_eq!(todays.len(), 3);
    let labels: std::collections::HashSet<&str> = todays.iter().map(|m| m["label"].as_str().unwrap()).collect();
    assert_eq!(labels.len(), 3);
    let mid = todays[0]["id"].as_str().unwrap().to_string();
    assert_eq!(m(&st, &mid)["progress"], 0);
    assert_eq!((st["streak"]["days"].as_i64(), st["streak"]["today"].as_bool()), (Some(0), Some(false)));
    let early = call(&app, "POST", &format!("/api/missions/{mid}/claim"), Some(&c), Some(json!({}))).await;
    assert_eq!((early.status, early.body["error"].as_str()), (StatusCode::CONFLICT, Some("mission_not_ready")));
    let mut last = Value::Null;
    for _ in 0..2 {
        last = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await.body;
    }
    let st = &last["state"];
    assert_eq!(kit::day_count(&db, id, "opened").await, 2);
    assert_eq!(
        (st["streak"]["days"].as_i64(), st["streak"]["today"].as_bool()),
        (Some(1), Some(true)),
        "first pack starts the streak"
    );
    // Whatever today's first mission is, plenty of progress on every kind finishes it.
    kit::finish_missions(&db, id).await;
    let parts = kit::parts(&db, id).await;
    let got = call(&app, "POST", &format!("/api/missions/{mid}/claim"), Some(&c), Some(json!({}))).await;
    assert_eq!(got.status, StatusCode::OK, "{}", got.body);
    assert_eq!(got.body["parts"].as_i64().unwrap(), parts + m(&got.body, &mid)["reward"].as_i64().unwrap());
    assert_eq!(m(&got.body, &mid)["claimed"], true);
    let again = call(&app, "POST", &format!("/api/missions/{mid}/claim"), Some(&c), Some(json!({}))).await;
    assert_eq!(again.status, StatusCode::CONFLICT, "a mission pays once a day");
    assert_eq!(
        call(&app, "POST", "/api/missions/nope/claim", Some(&c), Some(json!({}))).await.status,
        StatusCode::NOT_FOUND
    );

    // Day 7 of a streak: a boosted pack.
    kit::set_streak(&db, id, 6, 1).await;
    call(&app, "POST", "/api/dev/pack", Some(&c), Some(json!({ "pack": PACK }))).await;
    let o = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await.body;
    assert_eq!(o["streakReward"], true);
    assert_eq!(o["state"]["streak"]["days"], 7);
    let p = o["state"]["packs"].as_array().unwrap().iter().find(|p| p["id"] == PACK).unwrap().clone();
    assert_eq!(p["boosted"], 1, "the streak reward is a boosted pack");
    // A missed day halves the streak instead of wiping it.
    kit::set_streak(&db, id, 10, 3).await;
    let o = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK }))).await.body;
    assert_eq!(o["state"]["streak"]["days"], 5);
}

/// Claiming one mission ten times at once pays once.
#[tokio::test]
async fn a_mission_pays_once_even_when_claimed_at_once() {
    let (app, db) = need_db!(setup(true));
    let (c, st) = player(&app, &db).await;
    let id = user_id(&db, &c).await;
    let mid = st["missions"][0]["id"].as_str().unwrap().to_string();
    let reward = st["missions"][0]["reward"].as_i64().unwrap();
    kit::finish_missions(&db, id).await;
    let jobs: Vec<_> = (0..10)
        .map(|_| {
            let (app, c, mid) = (app.clone(), c.clone(), mid.clone());
            async move { call(&app, "POST", &format!("/api/missions/{mid}/claim"), Some(&c), Some(json!({}))).await }
        })
        .collect();
    let rs = futures_join(jobs).await;
    assert_eq!(rs.iter().filter(|r| r.status == StatusCode::OK).count(), 1);
    assert_eq!(kit::parts(&db, id).await, reward);
}

#[tokio::test]
async fn profiles_showcase_and_wishlist() {
    let (app, db) = need_db!(setup(true));
    let (ca, sa) = player(&app, &db).await;
    let (cb, _) = player(&app, &db).await;
    let a_name = sa["account"]["username"].as_str().unwrap().to_string();
    let a = user_id(&db, &ca).await;
    let (owned, other) = (team_of("rare", 30), team_of("common", 30));
    let serial = give_card(&db, a, owned, "rare").await;
    // Wishlist: add, list, remove; unknown teams refused.
    let w =
        call(&app, "POST", "/api/wishlist", Some(&ca), Some(json!({ "pack": PACK, "team": other, "on": true }))).await;
    assert_eq!(w.body, json!([other]));
    assert_eq!(
        call(&app, "POST", "/api/wishlist", Some(&ca), Some(json!({ "pack": PACK, "team": 99_999, "on": true })))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    let st = call(&app, "GET", "/api/state", Some(&ca), None).await.body;
    assert_eq!(st["wishlist"], json!([other]));
    // Showcase: only cards you own, at most 3.
    assert_eq!(
        call(&app, "POST", "/api/showcase", Some(&ca), Some(json!({ "pack": PACK, "teams": [other] }))).await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(&app, "POST", "/api/showcase", Some(&ca), Some(json!({ "pack": PACK, "teams": [1, 2, 3, 4] })))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(&app, "POST", "/api/showcase", Some(&ca), Some(json!({ "pack": PACK, "teams": [owned] }))).await.status,
        StatusCode::OK
    );
    // Another player sees it all.
    let p = call(&app, "GET", &format!("/api/players/{a_name}/profile/{PACK}"), Some(&cb), None).await;
    assert_eq!(p.status, StatusCode::OK, "{}", p.body);
    assert_eq!(p.body["me"], false);
    assert_eq!(p.body["showcase"][0]["num"], owned);
    assert_eq!(p.body["showcase"][0]["serial"], serial);
    assert_eq!(p.body["wishlist"], json!([other]));
    assert!(p.body["rarest"].as_array().unwrap().iter().any(|c| c["num"] == owned));
    let off =
        call(&app, "POST", "/api/wishlist", Some(&ca), Some(json!({ "pack": PACK, "team": other, "on": false }))).await;
    assert_eq!(off.body, json!([]));
    assert_eq!(
        call(&app, "GET", &format!("/api/players/nobody_here_x/profile/{PACK}"), Some(&cb), None).await.status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn usernames_reports_and_renames() {
    let (app, db) = need_db!(setup(true));
    let code = kit::invite(&db, 1).await;
    let r = call(
        &app,
        "POST",
        "/api/signup",
        None,
        Some(json!({ "code": code, "username": "sh1t_bot", "password": "hunter22!", "firstName": "Test" })),
    )
    .await;
    assert_eq!((r.status, r.body["error"].as_str()), (StatusCode::BAD_REQUEST, Some("username_not_allowed")));
    let (ca, _) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    let b = user_id(&db, &cb).await;
    let bad = call(&app, "POST", "/api/report", Some(&ca), Some(json!({ "username": b_name, "reason": "spam" }))).await;
    assert_eq!(bad.status, StatusCode::BAD_REQUEST, "unknown reason");
    let ok = call(
        &app,
        "POST",
        "/api/report",
        Some(&ca),
        Some(json!({ "username": b_name, "reason": "username", "details": "rude" })),
    )
    .await;
    assert_eq!(ok.status, StatusCode::NO_CONTENT);
    assert_eq!(
        call(&app, "POST", "/api/admin/reports/1/resolve", Some(&ca), Some(json!({}))).await.status,
        StatusCode::FORBIDDEN
    );
    let admin = make_admin(&app, &db).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let list = call(&app, "GET", "/api/admin/reports", Some(&admin), None).await.body;
    let rep = list.as_array().unwrap().iter().find(|r| r["target"] == b_name.as_str()).unwrap().clone();
    assert_eq!((rep["reason"].as_str(), rep["details"].as_str()), (Some("username"), Some("rude")));
    let renamed = format!("r{}", &Uuid::new_v4().simple().to_string()[..10]);
    let nope = call(
        &app,
        "POST",
        &format!("/api/admin/users/{b}/rename"),
        Some(&admin),
        Some(json!({ "username": "b1tch_x" })),
    )
    .await;
    assert_eq!(nope.body["error"], "username_not_allowed");
    let r =
        call(&app, "POST", &format!("/api/admin/users/{b}/rename"), Some(&admin), Some(json!({ "username": renamed })))
            .await;
    assert_eq!(r.status, StatusCode::NO_CONTENT);
    let st = call(&app, "GET", "/api/state", Some(&cb), None).await.body;
    assert_eq!(st["account"]["username"], renamed.as_str(), "renamed and still signed in");
    let id = rep["id"].as_i64().unwrap();
    assert_eq!(
        call(&app, "POST", &format!("/api/admin/reports/{id}/resolve"), Some(&admin), Some(json!({}))).await.status,
        StatusCode::NO_CONTENT
    );
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let list = call(&app, "GET", "/api/admin/reports", Some(&admin), None).await.body;
    assert!(list.as_array().unwrap().iter().all(|r| r["id"] != id), "resolved reports leave the list");
}

#[tokio::test]
async fn choose_pack_kind_and_trade_packs_and_parts() {
    let (app, db) = need_db!(setup(true));
    let (ca, _) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let (a, b) = (user_id(&db, &ca).await, user_id(&db, &cb).await);
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    // A: 2 standard + 1 boosted. Asking for a standard pack opens a standard one even with a boosted waiting.
    kit::set_packs(&db, a, PACK, 3, 1).await;
    kit::set_parts(&db, a, 500).await;
    let o = call(&app, "POST", "/api/open", Some(&ca), Some(json!({ "pack": PACK, "boosted": false }))).await;
    assert_eq!(packs_of(&o.body["state"]), (2, 1), "a standard pack was opened; the boosted one waits");
    // Can't trade away more standard packs than you have (the boosted one doesn't count).
    let too_many = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "givePacks": 2, "wantParts": 0, "want": [] })),
    )
    .await;
    assert_eq!(too_many.status, StatusCode::BAD_REQUEST, "both sides need something");
    let too_many = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "givePacks": 2, "wantPacks": 1 })),
    )
    .await;
    assert_eq!((too_many.status, too_many.body["error"].as_str()), (StatusCode::CONFLICT, Some("not_enough_to_trade")));
    // Brand-new accounts can't hand out packs or parts (against farming extra accounts).
    let fresh = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "givePacks": 1, "wantPacks": 1 })),
    )
    .await;
    assert_eq!(fresh.body["error"], "too_new");
    age(&db, &[a, b]).await;
    // B has 2 standard packs (starting packs). A offers 1 pack + 200 parts for 2 of B's packs.
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "givePacks": 1, "giveParts": 200, "wantPacks": 2 })),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let t = &r.body["outgoing"][0];
    assert_eq!(
        (t["youGivePacks"].as_i64(), t["youGiveParts"].as_i64(), t["youGetPacks"].as_i64()),
        (Some(1), Some(200), Some(2))
    );
    let id = t["id"].as_i64().unwrap();
    let ok = call(&app, "POST", &format!("/api/trades/{id}/accept"), Some(&cb), Some(json!({}))).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    assert_eq!(packs_of(&ok.body["state"]).0, 1, "B gave 2 and got 1");
    assert_eq!(ok.body["state"]["parts"], 200);
    let st = call(&app, "GET", "/api/state", Some(&ca), None).await.body;
    assert_eq!(packs_of(&st), (3, 1), "A: 2 - 1 + 2 = 3 sealed, still 1 boosted");
    assert_eq!(st["parts"], 300);
    // If the giver no longer has the parts when it's accepted, the trade fails and nothing moves.
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "giveParts": 300, "wantPacks": 1 })),
    )
    .await;
    let id = r.body["outgoing"][0]["id"].as_i64().unwrap();
    kit::set_parts(&db, a, 0).await;
    let stale = call(&app, "POST", &format!("/api/trades/{id}/accept"), Some(&cb), Some(json!({}))).await;
    assert_eq!(stale.body["error"], "trade_stale");
    assert_eq!(kit::parts(&db, b).await, 200);
}

#[tokio::test]
async fn a_retried_request_happens_once() {
    let (app, db) = need_db!(setup(true));
    let (c, st) = player(&app, &db).await;
    let me = user_id(&db, &c).await;
    let start = packs_of(&st).0;
    // Open: the same key twice (say the answer was lost and the app tried again) opens one pack, with one answer.
    let k = Uuid::new_v4().to_string();
    let a = call_key(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK })), Some(&k)).await;
    let b = call_key(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK })), Some(&k)).await;
    assert_eq!((a.status, b.status), (StatusCode::OK, StatusCode::OK));
    assert_eq!(a.body["opening"]["id"], b.body["opening"]["id"], "the retry gets the same pack");
    assert_eq!(a.body["opening"]["cards"], b.body["opening"]["cards"]);
    let now = call(&app, "GET", "/api/state", Some(&c), None).await.body;
    assert_eq!(packs_of(&now).0, start - 1, "only one pack was used");
    // Ten copies of one request at once still open one pack.
    let k = Uuid::new_v4().to_string();
    let mut jobs = Vec::new();
    for _ in 0..10 {
        let (app, c, k) = (app.clone(), c.clone(), k.clone());
        jobs.push(tokio::spawn(async move {
            call_key(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK })), Some(&k)).await
        }));
    }
    let mut ids = std::collections::HashSet::new();
    let mut ok = 0;
    for j in jobs {
        let r = j.await.unwrap();
        assert!(r.status == StatusCode::OK || r.body["error"] == "in_progress", "{} {}", r.status, r.body);
        if r.status == StatusCode::OK {
            ok += 1;
            ids.insert(r.body["opening"]["id"].as_i64().unwrap());
        }
    }
    assert!(ok >= 1);
    assert_eq!(ids.len(), 1, "one pack for ten copies of the request");
    assert_eq!(packs_of(&call(&app, "GET", "/api/state", Some(&c), None).await.body).0, start - 2);
    kit::add_sealed(&db, me, PACK, 2).await;
    // Craft: one key, parts spent once.
    kit::set_parts(&db, me, 600).await;
    let k = Uuid::new_v4().to_string();
    let a = call_key(&app, "POST", "/api/craft", Some(&c), Some(json!({})), Some(&k)).await;
    let b = call_key(&app, "POST", "/api/craft", Some(&c), Some(json!({})), Some(&k)).await;
    assert_eq!((a.status, b.status), (StatusCode::OK, StatusCode::OK));
    assert_eq!(a.body["parts"], 350);
    assert_eq!(call(&app, "GET", "/api/state", Some(&c), None).await.body["parts"], 350, "crafted once");
    // Scrap: one key, one copy scrapped.
    let team = team_of("common", 40);
    for _ in 0..3 {
        give_card(&db, me, team, "common").await;
    }
    let had = kit::count_cards(&db, me, PACK, team).await; // 3, or more if a pack opened above had this team
    let k = Uuid::new_v4().to_string();
    let body = json!({ "pack": PACK, "num": team, "count": 1 });
    let a = call_key(&app, "POST", "/api/scrap", Some(&c), Some(body.clone()), Some(&k)).await;
    let b = call_key(&app, "POST", "/api/scrap", Some(&c), Some(body), Some(&k)).await;
    assert_eq!((a.status, b.status), (StatusCode::OK, StatusCode::OK), "{} {}", a.body, b.body);
    assert_eq!(kit::count_cards(&db, me, PACK, team).await, had - 1, "one copy scrapped, not two");
    // A key can't be reused for a different action.
    let wrong = call_key(&app, "POST", "/api/craft", Some(&c), Some(json!({})), Some(&k)).await;
    assert_eq!(wrong.body["error"], "key_reused");
    // A request that failed can be retried with its key and then goes through.
    kit::set_parts(&db, me, 0).await;
    let k = Uuid::new_v4().to_string();
    assert_eq!(
        call_key(&app, "POST", "/api/craft", Some(&c), Some(json!({})), Some(&k)).await.body["error"],
        "not_enough_parts"
    );
    kit::set_parts(&db, me, 250).await;
    assert_eq!(call_key(&app, "POST", "/api/craft", Some(&c), Some(json!({})), Some(&k)).await.status, StatusCode::OK);
}

#[tokio::test]
async fn trade_offers_retry_once_and_daily_limits() {
    let (app, db) = need_db!(setup(true));
    let (ca, _) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let (a, b) = (user_id(&db, &ca).await, user_id(&db, &cb).await);
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    age(&db, &[a, b]).await;
    for u in [a, b] {
        kit::set_packs(&db, u, PACK, 30, 0).await;
        kit::set_parts(&db, u, 5000).await;
    }
    // The same offer sent twice with one key is one offer.
    let k = Uuid::new_v4().to_string();
    let offer = json!({ "to": b_name, "pack": PACK, "givePacks": 6, "wantParts": 10 });
    call_key(&app, "POST", "/api/trades", Some(&ca), Some(offer.clone()), Some(&k)).await;
    let again = call_key(&app, "POST", "/api/trades", Some(&ca), Some(offer.clone()), Some(&k)).await;
    assert_eq!(again.body["outgoing"].as_array().unwrap().len(), 1, "{}", again.body);
    let id = again.body["outgoing"][0]["id"].as_i64().unwrap();
    assert_eq!(
        call(&app, "POST", &format!("/api/trades/{id}/accept"), Some(&cb), Some(json!({}))).await.status,
        StatusCode::OK
    );
    // B has taken in 6 packs today; 5 more is over the daily 10.
    let over = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "givePacks": 5, "wantParts": 10 })),
    )
    .await;
    assert_eq!(over.body["error"], "their_trade_limit");
    let fine = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "givePacks": 4, "wantParts": 10 })),
    )
    .await;
    assert_eq!(fine.status, StatusCode::OK, "{}", fine.body);
    // Parts: at most 2000 a day in. A has taken in 10 already.
    let over = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "giveParts": 1, "wantParts": 1995 })),
    )
    .await;
    assert_eq!(over.body["error"], "trade_limit");
}

/// The daily intake limit holds even when several offers are accepted at the same moment.
#[tokio::test]
async fn daily_trade_limit_holds_under_a_race() {
    let (app, db) = need_db!(setup(true));
    let (cb, sb) = player(&app, &db).await;
    let b = user_id(&db, &cb).await;
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    age(&db, &[b]).await;
    kit::set_parts(&db, b, 5000).await;
    // Four givers each offer B 4 packs for 1 part: any three would put B over 10 packs in a day.
    let mut offers = Vec::new();
    for _ in 0..4 {
        let (ca, _) = player(&app, &db).await;
        let a = user_id(&db, &ca).await;
        age(&db, &[a]).await;
        kit::set_packs(&db, a, PACK, 10, 0).await;
        let r = call(
            &app,
            "POST",
            "/api/trades",
            Some(&ca),
            Some(json!({ "to": b_name, "pack": PACK, "givePacks": 4, "wantParts": 1 })),
        )
        .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        offers.push(r.body["outgoing"][0]["id"].as_i64().unwrap());
    }
    let jobs: Vec<_> = offers
        .iter()
        .map(|id| {
            let (app, cb, id) = (app.clone(), cb.clone(), *id);
            async move { call(&app, "POST", &format!("/api/trades/{id}/accept"), Some(&cb), Some(json!({}))).await }
        })
        .collect();
    let rs = futures_join(jobs).await;
    let ok = rs.iter().filter(|r| r.status == StatusCode::OK).count();
    assert_eq!(ok, 2, "two offers fit in the daily 10 packs, no more");
    let start = 2;
    assert_eq!(kit::packs(&db, b, PACK).await.sealed, start + 8);
}

#[tokio::test]
async fn finished_trades_keep_their_cards_in_history() {
    let (app, db) = need_db!(setup(true));
    let (ca, _) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let (a, b) = (user_id(&db, &ca).await, user_id(&db, &cb).await);
    age(&db, &[a, b]).await; // past the new-account rule: brand-new accounts can't give cards
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    let (x, y) = (team_of("common", 130), team_of("common", 131));
    give_card(&db, a, x, "common").await;
    give_card(&db, b, y, "common").await;
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [x], "want": [y] })),
    )
    .await;
    let id = r.body["outgoing"][0]["id"].as_i64().unwrap();
    call(&app, "POST", &format!("/api/trades/{id}/accept"), Some(&cb), Some(json!({}))).await;
    // B later loses the card A gave (scrapped, say); A's history still shows what was traded.
    kit::remove_team(&db, b, PACK, x).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let h = call(&app, "GET", "/api/trades", Some(&ca), None).await.body;
    let t = h["recent"].as_array().unwrap().iter().find(|t| t["id"] == id).unwrap();
    assert_eq!(t["youGive"][0]["num"], x);
    assert_eq!(t["youGet"][0]["num"], y);
}

#[tokio::test]
async fn everything_is_in_the_ledger_and_the_audit_adds_up() {
    let (app, db) = need_db!(setup(true));
    let admin = make_admin(&app, &db).await;
    let (ca, _) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let (a, b) = (user_id(&db, &ca).await, user_id(&db, &cb).await);
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    age(&db, &[a, b]).await;
    call(&app, "POST", "/api/claim", Some(&ca), Some(json!({}))).await;
    for _ in 0..3 {
        let o = call(&app, "POST", "/api/open", Some(&ca), Some(json!({ "pack": PACK }))).await;
        assert_eq!(o.status, StatusCode::OK, "{}", o.body);
        let id = o.body["opening"]["id"].as_i64().unwrap();
        call(&app, "POST", &format!("/api/openings/{id}/progress"), Some(&ca), Some(json!({ "revealed": 5 }))).await;
    }
    let extra = team_of("common", 50);
    give_card(&db, a, extra, "common").await;
    give_card(&db, a, extra, "common").await;
    let sc = call(
        &app,
        "POST",
        "/api/scrap/extras",
        Some(&ca),
        Some(json!({ "pack": PACK, "tiers": ["common", "uncommon", "rare"] })),
    )
    .await;
    assert_eq!(sc.status, StatusCode::OK, "{}", sc.body);
    kit::add_parts(&db, a, 300).await;
    assert_eq!(call(&app, "POST", "/api/craft", Some(&ca), Some(json!({}))).await.status, StatusCode::OK);
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "giveParts": 20, "wantPacks": 1 })),
    )
    .await;
    let id = r.body["outgoing"][0]["id"].as_i64().unwrap();
    assert_eq!(
        call(&app, "POST", &format!("/api/trades/{id}/accept"), Some(&cb), Some(json!({}))).await.status,
        StatusCode::OK
    );
    // The ledger has each kind of change with its reason.
    let l = call(&app, "GET", &format!("/api/admin/users/{a}/ledger"), Some(&admin), None).await;
    assert_eq!(l.status, StatusCode::OK);
    let reasons: Vec<String> =
        l.body.as_array().unwrap().iter().map(|e| e["reason"].as_str().unwrap().to_string()).collect();
    for want in ["new account", "claim", "open", "scrap", "craft", &format!("trade {id}")] {
        assert!(reasons.iter().any(|r| r == want), "ledger has {want}: {reasons:?}");
    }
    let cards_in: i64 = l
        .body
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["item"] == "card" && e["reason"] == "open")
        .map(|e| e["delta"].as_i64().unwrap())
        .sum();
    assert_eq!(cards_in, 15, "three packs, five cards each");
    // Every player's packs, parts and cards match their ledger.
    let audit = call(&app, "GET", "/api/admin/audit", Some(&admin), None).await;
    assert_eq!(audit.status, StatusCode::OK);
    let mine: Vec<&Value> = audit.body["mismatches"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["id"] == a.to_string() || m["id"] == b.to_string())
        .collect();
    assert!(mine.is_empty(), "{}", audit.body);
}

/// Everything at once on two accounts: opening, crafting, scrapping, offering and accepting trades with cards, packs
/// and parts. No request may fail with a server error, and afterwards everything adds up.
#[tokio::test]
async fn hammering_two_accounts_loses_nothing() {
    let (app, db) = need_db!(setup(true));
    let admin = make_admin(&app, &db).await;
    let (ca, sa) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let (a, b) = (user_id(&db, &ca).await, user_id(&db, &cb).await);
    let a_name = sa["account"]["username"].as_str().unwrap().to_string();
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    age(&db, &[a, b]).await;
    for u in [a, b] {
        kit::set_packs(&db, u, PACK, 40, 0).await;
        kit::set_parts(&db, u, 3000).await;
    }
    for c in [&ca, &cb] {
        for _ in 0..6 {
            call(&app, "POST", "/api/open", Some(c), Some(json!({ "pack": PACK }))).await;
        }
    }
    let mut jobs = Vec::new();
    for i in 0..120 {
        let (app, ca, cb, a_name, b_name) = (app.clone(), ca.clone(), cb.clone(), a_name.clone(), b_name.clone());
        jobs.push(tokio::spawn(async move {
            let (me, other, other_cookie) = if i % 2 == 0 { (ca, b_name, cb) } else { (cb, a_name, ca) };
            let r = match i % 6 {
                0 | 1 => call(&app, "POST", "/api/open", Some(&me), Some(json!({ "pack": PACK }))).await,
                2 => call(&app, "POST", "/api/craft", Some(&me), Some(json!({}))).await,
                3 => {
                    call(
                        &app,
                        "POST",
                        "/api/scrap/extras",
                        Some(&me),
                        Some(json!({ "pack": PACK, "tiers": ["common", "uncommon"] })),
                    )
                    .await
                }
                _ => {
                    let r = call(
                        &app,
                        "POST",
                        "/api/trades",
                        Some(&me),
                        Some(json!({ "to": other, "pack": PACK, "givePacks": 1, "giveParts": 7, "wantParts": 5 })),
                    )
                    .await;
                    match r.body["outgoing"].as_array().and_then(|o| o.first()).and_then(|t| t["id"].as_i64()) {
                        Some(id) => {
                            call(
                                &app,
                                "POST",
                                &format!("/api/trades/{id}/accept"),
                                Some(&other_cookie),
                                Some(json!({})),
                            )
                            .await
                        }
                        None => r,
                    }
                }
            };
            (r.status, r.body)
        }));
    }
    for j in jobs {
        let (st, body) = j.await.unwrap();
        assert!(st.as_u16() < 500, "server error under load: {st} {body}");
    }
    let audit = call(&app, "GET", "/api/admin/audit", Some(&admin), None).await;
    let mine: Vec<&Value> = audit.body["mismatches"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["id"] == a.to_string() || m["id"] == b.to_string())
        .collect();
    assert!(mine.is_empty(), "{}", audit.body);
    // Packs and parts never go negative, and boosted packs are never more than sealed ones.
    for u in [a, b] {
        let p = kit::packs(&db, u, PACK).await;
        assert!(p.sealed >= 0 && p.boosted >= 0 && p.boosted <= p.sealed, "{p:?}");
        assert!(kit::parts(&db, u).await >= 0);
    }
}

#[tokio::test]
async fn deleting_an_account_puts_its_cards_back_in_circulation() {
    let (app, db) = need_db!(own_setup(true));
    let admin = make_admin(&app, &db).await;
    let (ca, sa) = player(&app, &db).await;
    let (cb, _) = player(&app, &db).await;
    let (a, b) = (user_id(&db, &ca).await, user_id(&db, &cb).await);
    // A pack with five set teams, for A and then for B.
    let teams: Vec<(i32, &str)> = vec![
        (team_of("common", 141), "common"),
        (team_of("common", 142), "common"),
        (team_of("uncommon", 141), "uncommon"),
        (team_of("rare", 110), "rare"),
        (team_of("legendary", 45), "legendary"),
    ];
    let hand = json!(teams.iter().map(|(n, t)| json!({ "num": n, "tier": t })).collect::<Vec<_>>());
    kit::rig_next(&db, a, PACK, &hand).await;
    let oa = call(&app, "POST", "/api/open", Some(&ca), Some(json!({ "pack": PACK }))).await;
    assert_eq!(oa.status, StatusCode::OK, "{}", oa.body);
    let serial_of = |o: &Value, n: i32| {
        o["opening"]["cards"].as_array().unwrap().iter().find(|c| c["num"] == n).unwrap()["serial"].as_i64().unwrap()
    };
    assert!(oa.body["opening"]["cards"][0]["inGame"].as_i64().unwrap() >= 1, "each card says how many are in the game");
    let name = sa["account"]["username"].as_str().unwrap().to_string();
    let del =
        call(&app, "POST", &format!("/api/admin/users/{a}/delete"), Some(&admin), Some(json!({ "confirm": name })))
            .await;
    assert_eq!(del.status, StatusCode::NO_CONTENT, "{}", del.body);
    // Every one of A's serial numbers is free again.
    for (n, _) in &teams {
        assert!(
            kit::free_serial(&db, PACK, *n, serial_of(&oa.body, *n) as i32).await,
            "team {n}'s serial is back in circulation"
        );
    }
    // B pulls the same teams: no new numbers are printed; B gets the freed ones.
    let ns: Vec<i32> = teams.iter().map(|t| t.0).collect();
    let before = kit::minted(&db, PACK, &ns).await;
    kit::rig_next(&db, b, PACK, &hand).await;
    let ob = call(&app, "POST", "/api/open", Some(&cb), Some(json!({ "pack": PACK }))).await;
    assert_eq!(ob.status, StatusCode::OK, "{}", ob.body);
    assert_eq!(kit::minted(&db, PACK, &ns).await, before, "reused serials, printed none");
    for (n, _) in &teams {
        assert_eq!(serial_of(&ob.body, *n), serial_of(&oa.body, *n), "B got A's freed serial for {n}");
    }
    drop_table(&db).await;
}

#[tokio::test]
async fn admin_test_packs_save_nothing() {
    let (app, db) = need_db!(setup(true));
    let admin = make_admin(&app, &db).await;
    let (player_cookie, _) = player(&app, &db).await;
    let me = user_id(&db, &admin).await;
    // Only the admin can use it.
    let no = call(&app, "POST", "/api/admin/test-pack", Some(&player_cookie), Some(json!({ "pack": PACK }))).await;
    assert_eq!(no.status, StatusCode::FORBIDDEN);
    assert_eq!(
        call(&app, "POST", "/api/admin/test-pack", None, Some(json!({ "pack": PACK }))).await.status,
        StatusCode::UNAUTHORIZED
    );
    // Snapshot everything a real pack would change.
    let snap = || {
        let db = db.clone();
        async move {
            (
                kit::packs(&db, me, PACK).await,
                kit::count_items(&db, me, "CARD#").await,
                kit::count_items(&db, me, "OPEN#").await,
                kit::count_items(&db, me, "HAND#").await,
                kit::count_items(&db, me, "LED#").await,
            )
        }
    };
    let before = snap().await;
    for boosted in [false, true, false, false] {
        let r =
            call(&app, "POST", "/api/admin/test-pack", Some(&admin), Some(json!({ "pack": PACK, "boosted": boosted })))
                .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let cards = r.body["cards"].as_array().unwrap();
        assert_eq!(cards.len(), 5);
        let teams: std::collections::HashSet<i64> = cards.iter().map(|c| c["num"].as_i64().unwrap()).collect();
        assert_eq!(teams.len(), 5, "no team twice in a pack");
        assert!(rank(&cards[4]["tier"]) >= rank(&cards[0]["tier"]), "best card last");
    }
    assert_eq!(snap().await, before, "the admin's packs, pity, cards, openings and ledger did not change");
}

#[tokio::test]
async fn first_name_is_required_and_social_lists_players() {
    let (app, db) = need_db!(own_setup(false));
    let code = kit::invite(&db, 2).await;
    let missing = call(
        &app,
        "POST",
        "/api/signup",
        None,
        Some(json!({ "code": code, "username": name(), "password": "hunter22!" })),
    )
    .await;
    assert_eq!((missing.status, missing.body["error"].as_str()), (StatusCode::BAD_REQUEST, Some("bad_first_name")));
    let (who, cookie, _) = signup(&app, &db, &name()).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let r = call(&app, "GET", &format!("/api/social/{PACK}"), Some(&cookie), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let me = r.body["players"].as_array().unwrap().iter().find(|p| p["name"] == who.as_str()).expect("listed");
    assert_eq!(me["firstName"], "Test");
    assert!(r.body["recent"].is_array());
    assert!(r.body["activity"].is_array());
    drop_table(&db).await;
}

#[tokio::test]
async fn boosted_packs_trade_like_cards() {
    let (app, db) = need_db!(setup(true));
    let (ca, _) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let (a, b) = (user_id(&db, &ca).await, user_id(&db, &cb).await);
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    age(&db, &[a, b]).await;
    // A: 5 packs, 2 of them boosted. B: 2 standard packs.
    kit::set_packs(&db, a, PACK, 5, 2).await;
    kit::set_packs(&db, b, PACK, 2, 0).await;
    // A has only 2 boosted packs to give.
    let over = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "giveBoosted": 3, "wantPacks": 1 })),
    )
    .await;
    assert_eq!((over.status, over.body["error"].as_str()), (StatusCode::CONFLICT, Some("not_enough_to_trade")));
    // A gives 1 boosted + 1 standard pack for B's 2 standard packs.
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "giveBoosted": 1, "givePacks": 1, "wantPacks": 2 })),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let t = &r.body["outgoing"][0];
    assert_eq!(
        (t["youGiveBoosted"].as_i64(), t["youGivePacks"].as_i64(), t["youGetPacks"].as_i64()),
        (Some(1), Some(1), Some(2))
    );
    let id = t["id"].as_i64().unwrap();
    let ok = call(&app, "POST", &format!("/api/trades/{id}/accept"), Some(&cb), Some(json!({}))).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    assert_eq!(packs_of(&ok.body["state"]), (2, 1), "B: 2 - 2 + 2 = 2 sealed, now 1 boosted");
    let st = call(&app, "GET", "/api/state", Some(&ca), None).await.body;
    assert_eq!(packs_of(&st), (5, 1), "A: 5 - 2 + 2 = 5 sealed, 1 boosted left");
}

#[tokio::test]
async fn special_editions_are_numbered_and_admin_only() {
    // A table of its own, so the edition's numbers start fresh.
    let Some(db) = table(&format!("frc-sp-{}", Uuid::new_v4().simple())).await else { return };
    let app = router(&db, false, false);
    let admin = make_admin(&app, &db).await;
    let (cp, sp) = player(&app, &db).await;
    let who = sp["account"]["username"].as_str().unwrap().to_string();
    let no =
        call(&app, "POST", "/api/specials/grant", Some(&cp), Some(json!({ "username": who, "edition": "beta7028" })))
            .await;
    assert_eq!(no.status, StatusCode::FORBIDDEN, "only the admin hands them out");
    let first = call(
        &app,
        "POST",
        "/api/specials/grant",
        Some(&admin),
        Some(json!({ "username": who, "edition": "beta7028", "serial": 1 })),
    )
    .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    assert_eq!((first.body["serial"].as_i64(), first.body["total"].as_i64()), (Some(1), Some(100)));
    let again = call(
        &app,
        "POST",
        "/api/specials/grant",
        Some(&admin),
        Some(json!({ "username": who, "edition": "beta7028", "serial": 1 })),
    )
    .await;
    assert_eq!(again.body["error"], "serial_taken", "a number is only ever used once");
    let next = call(
        &app,
        "POST",
        "/api/specials/grant",
        Some(&admin),
        Some(json!({ "username": who, "edition": "beta7028" })),
    )
    .await;
    assert_eq!(next.body["serial"], 2, "the next free number");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let mine = call(&app, "GET", "/api/specials", Some(&cp), None).await;
    assert_eq!(mine.body.as_array().unwrap().len(), 2);
    let unknown =
        call(&app, "POST", "/api/specials/grant", Some(&admin), Some(json!({ "username": who, "edition": "nope" })))
            .await;
    assert_eq!(unknown.status, StatusCode::NOT_FOUND);
    // Granting one number to two players at once: one gets it.
    let (cq, sq) = player(&app, &db).await;
    let other = sq["account"]["username"].as_str().unwrap().to_string();
    let jobs: Vec<_> = [who.clone(), other.clone()]
        .into_iter()
        .map(|u| {
            let (app, admin) = (app.clone(), admin.clone());
            async move {
                call(
                    &app,
                    "POST",
                    "/api/specials/grant",
                    Some(&admin),
                    Some(json!({ "username": u, "edition": "beta7028", "serial": 50 })),
                )
                .await
            }
        })
        .collect();
    let rs = futures_join(jobs).await;
    assert_eq!(rs.iter().filter(|r| r.status == StatusCode::OK).count(), 1, "number 50 exists once");
    let _ = cq;
    db.client.delete_table().table_name(&db.table).send().await.ok();
}

#[tokio::test]
async fn special_edition_cards_can_be_traded() {
    let (app, db) = need_db!(setup(true));
    let admin = make_admin(&app, &db).await;
    let (ca, sa) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let (a, b) = (user_id(&db, &ca).await, user_id(&db, &cb).await);
    let (a_name, b_name) = (
        sa["account"]["username"].as_str().unwrap().to_string(),
        sb["account"]["username"].as_str().unwrap().to_string(),
    );
    age(&db, &[a, b]).await;
    let g = call(
        &app,
        "POST",
        "/api/specials/grant",
        Some(&admin),
        Some(json!({ "username": a_name, "edition": "beta7028" })),
    )
    .await;
    assert_eq!(g.status, StatusCode::OK, "{}", g.body);
    let sid = g.body["id"].as_i64().unwrap();
    let serial = g.body["serial"].clone();
    // B can't offer a special card they don't own.
    let nope = call(
        &app,
        "POST",
        "/api/trades",
        Some(&cb),
        Some(json!({ "to": a_name, "pack": PACK, "giveSpecials": [sid], "wantPacks": 1 })),
    )
    .await;
    assert_eq!(nope.body["error"], "not_owned");
    // B has packs from the start; A offers the special card for one of B's packs.
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "giveSpecials": [sid], "wantPacks": 1 })),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let t = &r.body["outgoing"][0];
    assert_eq!(t["youGiveSpecials"][0]["serial"], serial);
    let id = t["id"].as_i64().unwrap();
    let ok = call(&app, "POST", &format!("/api/trades/{id}/accept"), Some(&cb), Some(json!({}))).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    assert_eq!(kit::special_owner(&db, sid).await, b, "the special card moved to the other player");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let mine = call(&app, "GET", "/api/specials", Some(&cb), None).await;
    assert_eq!(mine.body[0]["serial"], serial);
}

#[tokio::test]
async fn collector_level_pays_parts_once_per_level() {
    let (app, db) = need_db!(setup(true));
    let (c, st) = player(&app, &db).await;
    let id = user_id(&db, &c).await;
    assert_eq!(st["level"]["per"], 25);
    let none = call(&app, "POST", "/api/level/claim", Some(&c), Some(json!({}))).await;
    assert_eq!(none.body["error"], "nothing_to_claim");
    // 50 different teams owned: level 2.
    let recipe = recipe();
    for t in recipe["teams"].as_array().unwrap().iter().take(50) {
        give_card(&db, id, t["num"].as_i64().unwrap() as i32, t["tier"].as_str().unwrap()).await;
    }
    let parts = kit::parts(&db, id).await;
    let r = call(&app, "POST", "/api/level/claim", Some(&c), Some(json!({}))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.body["level"]["level"].as_i64().unwrap() >= 2);
    assert_eq!(r.body["level"]["claimed"], r.body["level"]["level"]);
    assert!(r.body["parts"].as_i64().unwrap() >= parts + 200, "100 parts a level");
    let again = call(&app, "POST", "/api/level/claim", Some(&c), Some(json!({}))).await;
    assert_eq!(again.body["error"], "nothing_to_claim", "each level pays once");
}

#[tokio::test]
async fn username_and_first_name_can_be_changed() {
    let (app, db) = need_db!(setup(false));
    let (who, cookie, _) = signup(&app, &db, &name()).await;
    let (taken, _, _) = signup(&app, &db, &name()).await;
    let new = name();
    let bad_pw = call(
        &app,
        "POST",
        "/api/account/username",
        Some(&cookie),
        Some(json!({ "username": new, "password": "wrong-password" })),
    )
    .await;
    assert_eq!(bad_pw.body["error"], "bad_login");
    let bad_name = call(
        &app,
        "POST",
        "/api/account/username",
        Some(&cookie),
        Some(json!({ "username": "no spaces", "password": "hunter22!" })),
    )
    .await;
    assert_eq!(bad_name.body["error"], "bad_username");
    let dupe = call(
        &app,
        "POST",
        "/api/account/username",
        Some(&cookie),
        Some(json!({ "username": taken.to_uppercase(), "password": "hunter22!" })),
    )
    .await;
    assert_eq!(dupe.body["error"], "username_taken");
    let ok = call(
        &app,
        "POST",
        "/api/account/username",
        Some(&cookie),
        Some(json!({ "username": new, "password": "hunter22!" })),
    )
    .await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    assert_eq!(ok.body["account"]["username"], new.as_str());
    assert!(ok.body["account"]["renameAt"].is_i64(), "the next change is a while away");
    let again = call(
        &app,
        "POST",
        "/api/account/username",
        Some(&cookie),
        Some(json!({ "username": name(), "password": "hunter22!" })),
    )
    .await;
    assert_eq!(again.body["error"], "rename_too_soon");
    let old_login =
        call(&app, "POST", "/api/login", None, Some(json!({ "username": who, "password": "hunter22!" }))).await;
    assert_eq!(old_login.body["error"], "bad_login", "the old name no longer signs in");
    // The old name is free for someone else now.
    let (_, _, _) = signup(&app, &db, &who).await;
    let fname = call(&app, "POST", "/api/account/name", Some(&cookie), Some(json!({ "firstName": "Riley" }))).await;
    assert_eq!(fname.body["account"]["firstName"], "Riley");
    let empty = call(&app, "POST", "/api/account/name", Some(&cookie), Some(json!({ "firstName": "  " }))).await;
    assert_eq!(empty.body["error"], "bad_first_name");
}

#[tokio::test]
async fn favorite_cards_are_never_scrapped() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    let id = user_id(&db, &c).await;
    let team = team_of("common", 30);
    for _ in 1..=3 {
        give_card(&db, id, team, "common").await;
    }
    let not_owned =
        call(&app, "POST", "/api/favorites", Some(&c), Some(json!({ "pack": PACK, "team": team + 1000, "on": true })))
            .await;
    assert_eq!(not_owned.body["error"], "not_owned");
    let fav =
        call(&app, "POST", "/api/favorites", Some(&c), Some(json!({ "pack": PACK, "team": team, "on": true }))).await;
    assert_eq!(fav.status, StatusCode::OK, "{}", fav.body);
    let r = call(&app, "POST", "/api/scrap/extras", Some(&c), Some(json!({ "pack": PACK, "tiers": ["common"] }))).await;
    assert_eq!(r.body["scrapped"], 0, "{}", r.body);
    assert_eq!(kit::count_cards(&db, id, PACK, team).await, 3, "every copy of a favorite stays");
    call(&app, "POST", "/api/favorites", Some(&c), Some(json!({ "pack": PACK, "team": team, "on": false }))).await;
    let r2 =
        call(&app, "POST", "/api/scrap/extras", Some(&c), Some(json!({ "pack": PACK, "tiers": ["common"] }))).await;
    assert!(r2.body["scrapped"].as_i64().unwrap() >= 2, "without the favorite mark, extras scrap again");
}

#[tokio::test]
async fn trades_can_name_the_exact_serial() {
    let (app, db) = need_db!(setup(true));
    let (ca, _) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let (a, b) = (user_id(&db, &ca).await, user_id(&db, &cb).await);
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    age(&db, &[a, b]).await;
    let team = team_of("common", 45);
    let mut serials = Vec::new();
    for _ in 0..3 {
        serials.push(give_card(&db, a, team, "common").await);
    }
    let other = team_of("rare", 45);
    let theirs = give_card(&db, b, other, "rare").await;
    // A gives the middle copy, not the newest one.
    let r = call(&app, "POST", "/api/trades", Some(&ca), Some(json!({ "to": b_name, "pack": PACK, "give": [team], "giveSerials": [serials[1]], "want": [other], "wantSerials": [theirs] }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["outgoing"][0]["youGive"][0]["serial"], serials[1]);
    let nope = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [team], "giveSerials": [999_999], "want": [other] })),
    )
    .await;
    assert_eq!(nope.body["error"], "not_owned", "a serial you don't have can't be offered");
}

/// A card offered in one open offer can't be promised in a second offer by the same player.
#[tokio::test]
async fn one_card_can_only_be_promised_once() {
    let (app, db) = need_db!(setup(true));
    let (ca, _) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let (a, b) = (user_id(&db, &ca).await, user_id(&db, &cb).await);
    age(&db, &[a, b]).await; // past the new-account rule: brand-new accounts can't give cards
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    let (x, y) = (team_of("common", 125), team_of("common", 126));
    let only = give_card(&db, a, x, "common").await;
    give_card(&db, b, y, "common").await;
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [x], "want": [y] })),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.body["outgoing"][0]["youGive"][0]["serial"], only);
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let again = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [x], "want": [y] })),
    )
    .await;
    assert_eq!(again.body["error"], "card_held", "the only copy is already promised, and says so");
}

/// Someone else's session cookie, a made-up trade id, or another player's opening: none of it works.
#[tokio::test]
async fn players_cannot_act_for_each_other() {
    let (app, db) = need_db!(setup(true));
    let (ca, _) = player(&app, &db).await;
    let (cb, sb) = player(&app, &db).await;
    let (cc, _) = player(&app, &db).await;
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    let (a, b) = (user_id(&db, &ca).await, user_id(&db, &cb).await);
    age(&db, &[a, b, user_id(&db, &cc).await]).await; // past the new-account rule: brand-new accounts can't give cards
    let (x, y) = (team_of("common", 127), team_of("common", 128));
    give_card(&db, a, x, "common").await;
    give_card(&db, b, y, "common").await;
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [x], "want": [y] })),
    )
    .await;
    let id = r.body["outgoing"][0]["id"].as_i64().unwrap();
    // A third player can't accept, decline or cancel it.
    for what in ["accept", "decline", "cancel"] {
        let r = call(&app, "POST", &format!("/api/trades/{id}/{what}"), Some(&cc), Some(json!({}))).await;
        assert_eq!(r.status, StatusCode::FORBIDDEN, "{what}");
    }
    assert_eq!(
        call(&app, "POST", "/api/trades/999999999/accept", Some(&cb), Some(json!({}))).await.status,
        StatusCode::NOT_FOUND
    );
    // Offering to yourself.
    let me = call(&app, "GET", "/api/state", Some(&ca), None).await.body["account"]["username"]
        .as_str()
        .unwrap()
        .to_string();
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": me, "pack": PACK, "give": [x], "wantPacks": 1 })),
    )
    .await;
    assert_eq!(r.body["error"], "not_yourself");
    // Asking for more than exists in a side, or negative amounts.
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "giveParts": -5, "wantPacks": 1 })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [x, x, x, x, x, x], "wantPacks": 1 })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "at most 5 cards a side");
}

#[tokio::test]
async fn beta_testers_send_feedback_and_the_admin_sorts_it() {
    let (app, db) = need_db!(own_setup(false));
    let (ca, sa) = player(&app, &db).await;
    let (cb, _) = player(&app, &db).await;
    let admin = make_admin(&app, &db).await;
    let a_name = sa["account"]["username"].as_str().unwrap().to_string();
    // Needs a sign-in, a known kind and a real title.
    let body = json!({ "kind": "bug", "title": "Card is cut off", "details": "Seen on my phone.", "context": "binder | v1 | Pixel 8" });
    assert_eq!(call(&app, "POST", "/api/feedback", None, Some(body.clone())).await.status, StatusCode::UNAUTHORIZED);
    for bad in [
        json!({ "kind": "spam", "title": "Hello there" }),
        json!({ "kind": "bug", "title": "  " }),
        json!({ "kind": "bug", "title": "ab" }),
        json!({ "kind": "bug", "title": "x".repeat(81) }),
        json!({ "kind": "bug", "title": "fine title", "details": "y".repeat(1501) }),
        json!({ "kind": "bug", "title": "bad \u{0007} bell" }),
    ] {
        assert_eq!(
            call(&app, "POST", "/api/feedback", Some(&ca), Some(bad.clone())).await.status,
            StatusCode::BAD_REQUEST,
            "{bad}"
        );
    }
    assert_eq!(call(&app, "POST", "/api/feedback", Some(&ca), Some(body)).await.status, StatusCode::NO_CONTENT);
    call(&app, "POST", "/api/feedback", Some(&cb), Some(json!({ "kind": "idea", "title": "Add dark mode" }))).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    // A player sees only their own, without the admin's extra details.
    let mine = call(&app, "GET", "/api/feedback/mine", Some(&ca), None).await;
    assert_eq!(mine.status, StatusCode::OK, "{}", mine.body);
    let list = mine.body.as_array().unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0]["title"].as_str(), list[0]["status"].as_str()), (Some("Card is cut off"), Some("open")));
    assert!(list[0].get("username").is_none() && list[0].get("context").is_none(), "{}", list[0]);
    // Only the admin sees everyone's, with who sent it and where they were.
    assert_eq!(call(&app, "GET", "/api/admin/feedback", Some(&ca), None).await.status, StatusCode::FORBIDDEN);
    assert_eq!(call(&app, "GET", "/api/admin/feedback", None, None).await.status, StatusCode::UNAUTHORIZED);
    let all = call(&app, "GET", "/api/admin/feedback", Some(&admin), None).await.body;
    let item = all.as_array().unwrap().iter().find(|f| f["title"] == "Card is cut off").unwrap().clone();
    assert_eq!(
        (item["username"].as_str(), item["context"].as_str()),
        (Some(a_name.as_str()), Some("binder | v1 | Pixel 8"))
    );
    assert!(all.as_array().unwrap().iter().any(|f| f["title"] == "Add dark mode"));
    // The admin sets a status and a note; the sender sees it. Players can't.
    let id = item["id"].as_i64().unwrap();
    let st = json!({ "status": "done", "note": "Fixed in the next update" });
    assert_eq!(
        call(&app, "POST", &format!("/api/admin/feedback/{id}/status"), Some(&ca), Some(st.clone())).await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/api/admin/feedback/{id}/status"),
            Some(&admin),
            Some(json!({ "status": "maybe" }))
        )
        .await
        .status,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(&app, "POST", "/api/admin/feedback/999999999/status", Some(&admin), Some(st.clone())).await.status,
        StatusCode::NOT_FOUND
    );
    let done = call(&app, "POST", &format!("/api/admin/feedback/{id}/status"), Some(&admin), Some(st)).await;
    assert_eq!(done.status, StatusCode::OK);
    assert_eq!(done.body["rewarded"], true, "the sender earned a pack");
    let mine = call(&app, "GET", "/api/feedback/mine", Some(&ca), None).await.body;
    assert_eq!(
        (mine[0]["status"].as_str(), mine[0]["note"].as_str()),
        (Some("done"), Some("Fixed in the next update"))
    );
    // Ten a day.
    for i in 0..9 {
        let r = call(
            &app,
            "POST",
            "/api/feedback",
            Some(&ca),
            Some(json!({ "kind": "other", "title": format!("note number {i}") })),
        )
        .await;
        assert_eq!(r.status, StatusCode::NO_CONTENT, "{i}");
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let r =
        call(&app, "POST", "/api/feedback", Some(&ca), Some(json!({ "kind": "other", "title": "one too many" }))).await;
    assert_eq!((r.status, r.body["error"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("too_much_feedback")));
    drop_table(&db).await;
}

#[tokio::test]
async fn owners_lists_who_has_a_card_most_copies_first() {
    let (app, db) = need_db!(own_setup(false));
    let (_, me_cookie, _) = signup(&app, &db, &name()).await;
    let (one, one_cookie, _) = signup(&app, &db, &name()).await;
    let (two, two_cookie, _) = signup(&app, &db, &name()).await;
    let (none, _, _) = signup(&app, &db, &name()).await;
    let (me_id, one_id, two_id) =
        (user_id(&db, &me_cookie).await, user_id(&db, &one_cookie).await, user_id(&db, &two_cookie).await);
    give_card(&db, me_id, 7028, "legendary").await;
    give_card(&db, one_id, 7028, "legendary").await;
    give_card(&db, two_id, 7028, "legendary").await;
    give_card(&db, two_id, 7028, "legendary").await;

    let r = call(&app, "GET", &format!("/api/owners/{PACK}/7028"), Some(&me_cookie), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let got: Vec<(String, i64)> = r
        .body
        .as_array()
        .unwrap()
        .iter()
        .map(|o| (o["name"].as_str().unwrap().to_string(), o["copies"].as_i64().unwrap()))
        .collect();
    assert_eq!(got, vec![(two, 2), (one, 1)], "you're left out, and so is {none}, who has none");
    assert!(
        call(&app, "GET", &format!("/api/owners/{PACK}/7028"), None, None).await.status.is_client_error(),
        "signed in only"
    );
}

/// A pack its owner hasn't finished opening isn't theirs to trade yet, so nobody else sees its cards (they'd only be
/// told the card isn't available), and its owner is told why when they offer one.
#[tokio::test]
async fn a_pack_being_opened_stays_out_of_sight_until_revealed() {
    let (app, db) = need_db!(own_setup(true));
    let (opener, oc, _) = signup(&app, &db, &name()).await;
    let (viewer, vc, _) = signup(&app, &db, &name()).await;
    let o = call(&app, "POST", "/api/open", Some(&oc), Some(json!({ "pack": PACK }))).await;
    assert_eq!(o.status, StatusCode::OK, "{}", o.body);
    let id = o.body["opening"]["id"].as_i64().unwrap();
    let first = o.body["opening"]["cards"][0]["num"].as_i64().unwrap();

    let seen =
        |b: &Value| b["cards"].as_array().unwrap().iter().map(|c| c["num"].as_i64().unwrap()).collect::<Vec<_>>();
    let theirs = call(&app, "GET", &format!("/api/players/{opener}/collection/{PACK}"), Some(&vc), None).await;
    assert!(seen(&theirs.body).is_empty(), "nothing shows mid-reveal: {}", theirs.body);
    let mine = call(&app, "GET", &format!("/api/collection/{PACK}"), Some(&oc), None).await;
    assert_eq!(seen(&mine.body).len(), 5, "your own binder still has them");

    let offer = call(
        &app,
        "POST",
        "/api/trades",
        Some(&oc),
        Some(json!({ "to": viewer, "pack": PACK, "give": [first], "wantParts": 0, "wantPacks": 1 })),
    )
    .await;
    assert_eq!(offer.body["error"], "card_held", "{}", offer.body);

    call(&app, "POST", &format!("/api/openings/{id}/progress"), Some(&oc), Some(json!({ "revealed": 5 }))).await;
    let theirs = call(&app, "GET", &format!("/api/players/{opener}/collection/{PACK}"), Some(&vc), None).await;
    assert_eq!(seen(&theirs.body).len(), 5, "all turned over: everyone sees them");
}

/// The Battler's robot effects reach FRC Packs cards: shipped ones with their names, never test examples.
#[tokio::test]
async fn robot_effects_reach_the_cards() {
    let (app, db) = need_db!(setup(false));
    let (c, _) = player(&app, &db).await;
    let r = call(&app, "GET", "/api/battler/effects", Some(&c), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["7028"]["name"], "Bump n Dump");
    assert!(r.body["7028"]["text"].as_str().unwrap().contains("team 6800"), "{}", r.body);
    assert!(r.body.get("4414").is_none(), "4414's effect is only a test example");
}

// ---------- Tripwire, the anticheat ----------

/// The scan is for admins only.
#[tokio::test]
async fn tripwire_is_admin_only() {
    let (app, db) = need_db!(setup(false));
    let (c, _) = player(&app, &db).await;
    let target = user_id(&db, &c).await;
    for (method, path) in [
        ("GET", "/api/admin/anticheat/scan".to_string()),
        ("GET", "/api/admin/anticheat/log".to_string()),
        ("POST", format!("/api/admin/anticheat/users/{target}/flag")),
        ("POST", format!("/api/admin/anticheat/users/{target}/clear")),
        ("POST", format!("/api/admin/anticheat/users/{target}/reverse")),
    ] {
        let body = (method == "POST").then(|| json!({ "from": 0, "to": 1 }));
        assert_eq!(call(&app, method, &path, Some(&c), body).await.status, StatusCode::FORBIDDEN, "{path}");
    }
}

fn finding<'a>(report: &'a Value, user: Uuid, check: &str) -> Option<&'a Value> {
    let s = report["suspects"].as_array()?.iter().find(|s| s["id"] == user.to_string())?;
    s["findings"].as_array()?.iter().find(|f| f["check"] == check)
}

/// Packs from a source that can't have paid them (a timer paying far past its rule), and Mythics far beyond each pack's
/// recorded odds, both show up in the scan with their evidence. An honest player doesn't.
#[tokio::test]
async fn tripwire_finds_impossible_supply_and_luck() {
    let (app, db) = need_db!(own_setup(true));
    let admin = make_admin(&app, &db).await;
    // Saving the settings starts their history, which the timer check needs.
    let rules = call(&app, "GET", "/api/admin/settings", Some(&admin), None).await.body;
    assert_eq!(call(&app, "POST", "/api/admin/settings", Some(&admin), Some(rules)).await.status, StatusCode::OK);
    let (honest, _) = player(&app, &db).await;
    call(&app, "POST", "/api/open", Some(&honest), Some(json!({ "pack": PACK }))).await;
    let (cheat, _) = player(&app, &db).await;
    let cid = user_id(&db, &cheat).await;
    // A broken claim path paying 20 packs a time, written through the normal pack write (so the ledger balances).
    for _ in 0..3 {
        let before = kit::packs(&db, cid, PACK).await;
        let mut after = before.clone();
        after.sealed += 20;
        kit::change(&db, cid, move |p, tx| frc_packs_server::model::save_pack(tx, p, &before, &after, "claim")).await;
    }
    // Ten packs in a row each holding a Mythic (dev tools plant them; the scan only sees the openings).
    let m = team_of("mythic", 2);
    for i in 0..10 {
        let pack = json!([
            { "num": team_of("common", 10 + i), "tier": "common" }, { "num": team_of("common", 30 + i), "tier": "common" },
            { "num": team_of("common", 50 + i), "tier": "common" }, { "num": team_of("rare", i), "tier": "rare" },
            { "num": m, "tier": "mythic" }
        ]);
        kit::rig_next(&db, cid, PACK, &pack).await;
        let o = call(&app, "POST", "/api/open", Some(&cheat), Some(json!({ "pack": PACK }))).await;
        assert_eq!(o.status, StatusCode::OK, "{}", o.body);
    }
    let r = call(&app, "GET", "/api/admin/anticheat/scan", Some(&admin), None).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let supply = finding(&r.body, cid, "supply").expect("the impossible timer is found");
    assert!(supply["evidence"].to_string().contains("timer"), "{supply}");
    let luck = finding(&r.body, cid, "luck").expect("the impossible luck is found");
    assert!(luck["score"].as_i64().unwrap() >= 80, "{luck}");
    assert_eq!(r.body["suspects"][0]["id"], cid.to_string(), "the cheat is at the top");
    let hid = user_id(&db, &honest).await;
    assert!(
        r.body["suspects"].as_array().unwrap().iter().all(|s| s["id"] != hid.to_string()),
        "the honest player isn't listed"
    );
    drop_table(&db).await;
}

/// Flagging pauses trading (packs still open), clearing lifts it, and a reversal takes back what came in during a
/// window: previewed first, applied on request, logged, with the ledger still balancing.
#[tokio::test]
async fn tripwire_flag_clear_and_reverse() {
    let (app, db) = need_db!(own_setup(false));
    let admin = make_admin(&app, &db).await;
    let (a, sa) = player(&app, &db).await;
    let (b, sb) = player(&app, &db).await;
    let (ida, idb) = (user_id(&db, &a).await, user_id(&db, &b).await);
    age(&db, &[ida, idb]).await;
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    let _ = sa;
    let (x, y) = (team_of("common", 140), team_of("common", 141));
    give_card(&db, ida, x, "common").await;
    give_card(&db, idb, y, "common").await;

    let f = call(
        &app,
        "POST",
        &format!("/api/admin/anticheat/users/{ida}/flag"),
        Some(&admin),
        Some(json!({ "reason": "testing", "mode": "paused" })),
    )
    .await;
    assert_eq!(f.status, StatusCode::NO_CONTENT);
    let t = call(
        &app,
        "POST",
        "/api/trades",
        Some(&a),
        Some(json!({ "pack": PACK, "to": b_name, "give": [x], "want": [y] })),
    )
    .await;
    assert_eq!(t.body["error"], "under_review");
    assert_eq!(
        call(&app, "POST", "/api/open", Some(&a), Some(json!({ "pack": PACK }))).await.status,
        StatusCode::OK,
        "packs still open"
    );
    let c = call(
        &app,
        "POST",
        &format!("/api/admin/anticheat/users/{ida}/clear"),
        Some(&admin),
        Some(json!({ "reason": "ok" })),
    )
    .await;
    assert_eq!(c.status, StatusCode::NO_CONTENT);
    let t = call(
        &app,
        "POST",
        "/api/trades",
        Some(&a),
        Some(json!({ "pack": PACK, "to": b_name, "give": [x], "want": [y] })),
    )
    .await;
    assert_eq!(t.status, StatusCode::OK, "{}", t.body);

    // 10 packs and 300 parts come in; then the window is reversed.
    let start = frc_packs_server::model::now_ms();
    let before = kit::packs(&db, idb, PACK).await;
    let mut after = before.clone();
    after.sealed += 10;
    kit::change(&db, idb, move |p, tx| frc_packs_server::model::save_pack(tx, p, &before, &after, "claim")).await;
    kit::change(&db, idb, |p, _| p.parts += 300).await;
    let end = frc_packs_server::model::now_ms();
    let path = format!("/api/admin/anticheat/users/{idb}/reverse");
    let sealed_before = kit::packs(&db, idb, PACK).await.sealed;
    let pv = call(&app, "POST", &path, Some(&admin), Some(json!({ "from": start, "to": end }))).await;
    assert_eq!(pv.status, StatusCode::OK, "{}", pv.body);
    assert_eq!(
        (pv.body["tookPacks"].as_i64(), pv.body["tookParts"].as_i64(), pv.body["applied"].as_bool()),
        (Some(10), Some(300), Some(false))
    );
    assert_eq!(kit::packs(&db, idb, PACK).await.sealed, sealed_before, "a preview changes nothing");
    let ap = call(&app, "POST", &path, Some(&admin), Some(json!({ "from": start, "to": end, "apply": true }))).await;
    assert_eq!(ap.body["applied"], true, "{}", ap.body);
    assert_eq!(kit::packs(&db, idb, PACK).await.sealed, sealed_before - 10);
    let log = call(&app, "GET", "/api/admin/anticheat/log", Some(&admin), None).await.body;
    let actions: Vec<&str> = log.as_array().unwrap().iter().map(|a| a["action"].as_str().unwrap()).collect();
    assert_eq!(actions, vec!["reverse", "clear", "flag"], "every action is logged, newest first");
    let audit = call(&app, "GET", "/api/admin/audit", Some(&admin), None).await.body;
    assert_eq!(audit["mismatches"].as_array().unwrap().len(), 0, "the ledger still balances: {audit}");
    drop_table(&db).await;
}

/// Flags are shadow flags by default: the player notices nothing, and Tripwire logs what they do. Over 60 packs in an
/// hour pauses trading whatever the setting. With shadow flags off, a flag pauses trading.
#[tokio::test]
async fn tripwire_shadow_flags() {
    let (app, db) = need_db!(own_setup(false));
    let admin = make_admin(&app, &db).await;
    let (a, _) = player(&app, &db).await;
    let (b, sb) = player(&app, &db).await;
    let (ida, idb) = (user_id(&db, &a).await, user_id(&db, &b).await);
    age(&db, &[ida, idb]).await;
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    for _ in 0..4 {
        give_card(&db, ida, team_of("common", 142), "common").await;
        give_card(&db, idb, team_of("common", 143), "common").await;
    }
    let offer =
        || json!({ "pack": PACK, "to": b_name, "give": [team_of("common", 142)], "want": [team_of("common", 143)] });
    let take = |n: i32| {
        let db = db.clone();
        async move {
            let before = kit::packs(&db, ida, PACK).await;
            let mut after = before.clone();
            after.sealed += n;
            kit::change(&db, ida, move |p, tx| frc_packs_server::model::save_pack(tx, p, &before, &after, "claim"))
                .await;
        }
    };
    // 35 packs in an hour: flagged, silently. Trading carries on, and shows up on the watchlist.
    take(35).await;
    let p = frc_packs_server::model::profile(&db, ida).await.unwrap().unwrap();
    assert!(p.flagged.is_some() && p.flag_mode.is_none());
    let t = call(&app, "POST", "/api/trades", Some(&a), Some(offer())).await;
    assert_eq!(t.status, StatusCode::OK, "a shadow flag doesn't stop trading: {}", t.body);
    let st = call(&app, "GET", "/api/state", Some(&a), None).await.body;
    assert!(!st.to_string().contains("flag"), "the player can't see they're flagged");
    let ov = call(&app, "GET", "/api/admin/anticheat/overview", Some(&admin), None).await.body;
    let w = ov["watchlist"].as_array().unwrap().iter().find(|w| w["id"] == ida.to_string()).expect("on the watchlist");
    assert_eq!(w["mode"], "shadow");
    assert!(w["activity"][0]["what"].as_str().unwrap().contains("offered a trade"), "{w}");
    // Shadow flags off: the same flag pauses trading.
    let off =
        call(&app, "POST", "/api/admin/anticheat/config", Some(&admin), Some(json!({ "shadowDefault": false }))).await;
    assert_eq!(off.status, StatusCode::OK);
    let t = call(&app, "POST", "/api/trades", Some(&a), Some(offer())).await;
    assert_eq!(t.body["error"], "under_review");
    call(&app, "POST", "/api/admin/anticheat/config", Some(&admin), Some(json!({ "shadowDefault": true }))).await;
    assert_eq!(call(&app, "POST", "/api/trades", Some(&a), Some(offer())).await.status, StatusCode::OK);
    // 30 more in the same hour (65): paused, whatever the setting.
    take(30).await;
    let p = frc_packs_server::model::profile(&db, ida).await.unwrap().unwrap();
    assert_eq!(p.flag_mode.as_deref(), Some("paused"));
    assert_eq!(call(&app, "POST", "/api/trades", Some(&a), Some(offer())).await.body["error"], "under_review");
    drop_table(&db).await;
}

/// Retired endpoints are canaries: still "not found", but each call is logged with who made it, and shows in the scan.
#[tokio::test]
async fn tripwire_canaries() {
    let (app, db) = need_db!(own_setup(false));
    let admin = make_admin(&app, &db).await;
    let (c, _) = player(&app, &db).await;
    let id = user_id(&db, &c).await;
    for path in ["/api/hand", "/api/hand", "/api/craft/mythic"] {
        let r = call(&app, "POST", path, Some(&c), Some(json!({ "pack": PACK }))).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{path}");
    }
    let ov = call(&app, "GET", "/api/admin/anticheat/overview", Some(&admin), None).await.body;
    let hits = ov["canaries"].as_array().unwrap();
    assert_eq!(hits.len(), 3);
    assert!(hits.iter().all(|h| h["username"].is_string()), "{ov}");
    let scan = call(&app, "GET", "/api/admin/anticheat/scan", Some(&admin), None).await.body;
    let f = finding(&scan, id, "canary").expect("canary calls show in the scan");
    assert!(f["evidence"].to_string().contains("/api/hand 2 times"), "{f}");
    drop_table(&db).await;
}

#[tokio::test]
async fn scrapping_extras_can_keep_more_than_one() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    let id = user_id(&db, &c).await;
    let team = team_of("common", 120);
    let mut serials = Vec::new();
    for _ in 0..4 {
        serials.push(give_card(&db, id, team, "common").await);
    }
    let r = call(
        &app,
        "POST",
        "/api/scrap/extras",
        Some(&c),
        Some(json!({ "pack": PACK, "tiers": ["common"], "keep": 2 })),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["scrapped"], 2);
    let kept = r.body["collection"]["cards"].as_array().unwrap().iter().find(|x| x["num"] == team).unwrap().clone();
    let mut got: Vec<i64> = kept["serials"].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect();
    got.sort();
    assert_eq!(got, vec![i64::from(serials[0]), i64::from(serials[1])], "the two earliest copies are kept");
    // Out of range asks are held to 1 to 5.
    let r = call(
        &app,
        "POST",
        "/api/scrap/extras",
        Some(&c),
        Some(json!({ "pack": PACK, "tiers": ["common"], "keep": 0 })),
    )
    .await;
    assert_eq!(r.body["scrapped"], 1, "keep 0 counts as keep 1");
}

#[tokio::test]
async fn teams_you_get_leave_your_wishlist() {
    let (app, db) = need_db!(setup(true));
    let (ca, _) = player(&app, &db).await;
    let a = user_id(&db, &ca).await;
    // From a pack.
    let commons: Vec<i32> = (0..4).map(|i| team_of("common", 140 + i)).collect();
    let leg = team_of("legendary", 20);
    let still = team_of("rare", 70);
    for t in [commons[0], still] {
        call(&app, "POST", "/api/wishlist", Some(&ca), Some(json!({ "pack": PACK, "team": t, "on": true }))).await;
    }
    let mut hand: Vec<Value> = commons.iter().map(|n| json!({ "num": n, "tier": "common" })).collect();
    hand.push(json!({ "num": leg, "tier": "legendary" }));
    kit::rig_next(&db, a, PACK, &Value::Array(hand)).await;
    let o = call(&app, "POST", "/api/open", Some(&ca), Some(json!({ "pack": PACK }))).await;
    assert_eq!(o.status, StatusCode::OK, "{}", o.body);
    assert_eq!(o.body["state"]["wishlist"], json!([still]), "the pulled team is off the list, the other stays");

    // From a trade, and the new offer is in Sent straight away.
    let (cb, sb) = player(&app, &db).await;
    let b = user_id(&db, &cb).await;
    age(&db, &[a, b]).await;
    let b_name = sb["account"]["username"].as_str().unwrap().to_string();
    give_card(&db, b, still, "rare").await;
    let mine = give_card(&db, a, team_of("common", 160), "common").await;
    let _ = mine;
    let r = call(
        &app,
        "POST",
        "/api/trades",
        Some(&ca),
        Some(json!({ "to": b_name, "pack": PACK, "give": [team_of("common", 160)], "want": [still] })),
    )
    .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["outgoing"].as_array().unwrap().len(), 1, "the offer just sent is listed");
    let id = r.body["outgoing"][0]["id"].as_i64().unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let ok = call(&app, "POST", &format!("/api/trades/{id}/accept"), Some(&cb), Some(json!({}))).await;
    assert_eq!(ok.status, StatusCode::OK, "{}", ok.body);
    let st = call(&app, "GET", "/api/state", Some(&ca), None).await.body;
    assert_eq!(st["wishlist"], json!([]), "a team got in a trade leaves the list too");
}

// ---------- the shop (0.14) ----------

fn shop_item<'a>(shop: &'a Value, slot: &str) -> &'a Value {
    shop["items"].as_array().unwrap().iter().find(|i| i["slot"] == slot).unwrap()
}

async fn buy_slot(app: &Router, c: &str, item: &Value) -> Res {
    let body = json!({ "slot": item["slot"], "window": item["window"], "price": item["price"] });
    call_key(app, "POST", "/api/shop/buy", Some(c), Some(body), Some(&Uuid::new_v4().to_string())).await
}

/// A card from the shop: bought once per window, paid at the price shown, a fresh serial like a pull; a stale window or
/// price buys nothing. Ten buys of one slot at once: one card, paid once.
#[tokio::test]
async fn the_shop_sells_each_card_once() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    let id = user_id(&db, &c).await;
    kit::set_parts(&db, id, 1_000_000).await;
    let shop = call(&app, "GET", "/api/shop", Some(&c), None).await;
    assert_eq!(shop.status, StatusCode::OK, "{}", shop.body);
    assert_eq!(shop.body["items"].as_array().unwrap().len(), 4);
    let c1 = shop_item(&shop.body, "c1").clone();
    assert_eq!(c1["kind"], "card");
    let price = c1["price"].as_i64().unwrap();

    let stale = json!({ "slot": "c1", "window": c1["window"].as_i64().unwrap() - 1, "price": price });
    let r = call_key(&app, "POST", "/api/shop/buy", Some(&c), Some(stale), Some(&Uuid::new_v4().to_string())).await;
    assert_eq!(r.body["error"], "shop_changed");
    let cheap = json!({ "slot": "c1", "window": c1["window"], "price": price - 1 });
    let r = call_key(&app, "POST", "/api/shop/buy", Some(&c), Some(cheap), Some(&Uuid::new_v4().to_string())).await;
    assert_eq!(r.body["error"], "price_changed");
    assert_eq!(kit::parts(&db, id).await, 1_000_000, "nothing spent");

    let r = buy_slot(&app, &c, &c1).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["card"]["num"], c1["num"]);
    assert_eq!(r.body["state"]["parts"], 1_000_000 - price);
    assert_eq!(shop_item(&r.body["shop"], "c1")["sold"], true);
    let r = buy_slot(&app, &c, &c1).await;
    assert_eq!(r.body["error"], "sold_out");

    let c2 = shop_item(&shop.body, "c2").clone();
    let jobs: Vec<_> = (0..10)
        .map(|_| {
            let (app, c, c2) = (app.clone(), c.clone(), c2.clone());
            async move { buy_slot(&app, &c, &c2).await }
        })
        .collect();
    let rs = futures_join(jobs).await;
    assert_eq!(rs.iter().filter(|r| r.status == StatusCode::OK).count(), 1, "one card");
    assert!(rs.iter().all(|r| r.status.as_u16() < 500));
    assert_eq!(kit::parts(&db, id).await, 1_000_000 - price - c2["price"].as_i64().unwrap(), "paid once");
}

/// A frozen slot keeps its stock; only what's in the shop now can be frozen, one slot at a time.
#[tokio::test]
async fn a_shop_slot_can_be_frozen() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    let shop = call(&app, "GET", "/api/shop", Some(&c), None).await.body;
    let w = shop_item(&shop, "c3")["window"].as_i64().unwrap();
    let r = call(&app, "POST", "/api/shop/freeze", Some(&c), Some(json!({ "slot": "c3", "window": w - 1 }))).await;
    assert_eq!(r.body["error"], "shop_changed");
    let r = call(&app, "POST", "/api/shop/freeze", Some(&c), Some(json!({ "slot": "c3", "window": w }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(shop_item(&r.body, "c3")["frozen"], true);
    let r = call(&app, "POST", "/api/shop/freeze", Some(&c), Some(json!({ "slot": "c1", "window": w }))).await;
    assert_eq!(shop_item(&r.body, "c1")["frozen"], true);
    assert_eq!(shop_item(&r.body, "c3")["frozen"], false, "one at a time");
    let r = call(&app, "POST", "/api/shop/freeze", Some(&c), Some(json!({ "slot": null }))).await;
    assert!(r.body["items"].as_array().unwrap().iter().all(|i| i["frozen"] == false));
}

/// A division pack: bought, then opened at once with the usual opening, every card from its division, no sealed pack
/// used; it can't be opened twice.
#[tokio::test]
async fn a_division_pack_opens_from_its_division() {
    let (app, db) = need_db!(setup(true));
    let (c, st) = player(&app, &db).await;
    let id = user_id(&db, &c).await;
    kit::set_parts(&db, id, 10_000).await;
    let shop = call(&app, "GET", "/api/shop", Some(&c), None).await.body;
    let div = shop_item(&shop, "div").clone();
    let d = div["division"].as_str().unwrap().to_string();
    let r = buy_slot(&app, &c, &div).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["division"], d.as_str());
    let o = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK, "division": d }))).await;
    assert_eq!(o.status, StatusCode::OK, "{}", o.body);
    let teams = recipe();
    for card in o.body["opening"]["cards"].as_array().unwrap() {
        let t = teams["teams"].as_array().unwrap().iter().find(|t| t["num"] == card["num"]).unwrap();
        assert_eq!(t["div"], d.as_str(), "every card from {d}");
    }
    assert_eq!(sealed(&o.body["state"]), sealed(&st), "no sealed pack used");
    let again = call(&app, "POST", "/api/open", Some(&c), Some(json!({ "pack": PACK, "division": d }))).await;
    assert_eq!(again.body["error"], "no_packs");
}

/// Packs for parts, Standard and Boosted (crafting), as many as you can pay for: no daily limit, and buying lots at
/// once never sets off the intake alarm (bought packs are checked against their parts instead).
#[tokio::test]
async fn bought_packs_have_no_daily_limit() {
    let (app, db) = need_db!(setup(true));
    let (c, st) = player(&app, &db).await;
    let id = user_id(&db, &c).await;
    kit::set_parts(&db, id, 100_000).await;
    for k in 0..40 {
        let kind = if k % 2 == 0 { "std" } else { "boosted" };
        let key = Uuid::new_v4().to_string();
        let r = call_key(&app, "POST", "/api/shop/pack", Some(&c), Some(json!({ "kind": kind })), Some(&key)).await;
        assert_eq!(r.status, StatusCode::OK, "pack {k}: {}", r.body);
    }
    let r = call(&app, "POST", "/api/craft", Some(&c), Some(json!({}))).await;
    assert_eq!(r.status, StatusCode::OK, "crafting has no limit either");
    let now = call(&app, "GET", "/api/state", Some(&c), None).await.body;
    assert_eq!(packs_of(&now), (packs_of(&st).0 + 41, packs_of(&st).1 + 21));
    assert_eq!(now["parts"], 100_000 - 20 * 120 - 21 * st["boostCost"].as_i64().unwrap());
    let p = frc_packs_server::model::profile(&db, id).await.unwrap().unwrap();
    assert!(p.flagged.is_none(), "buying packs isn't a dupe: {:?}", p.flagged);
}

/// Any one copy can be scrapped when the player picks it: their only copy, or a Mythic. Scrapping all extras still
/// keeps one of each.
#[tokio::test]
async fn a_picked_copy_can_be_scrapped_even_the_last() {
    let (app, db) = need_db!(setup(true));
    let (c, _) = player(&app, &db).await;
    let id = user_id(&db, &c).await;
    let mythic = team_of("mythic", 3);
    let serial = give_card(&db, id, mythic, "mythic").await;
    let body = json!({ "pack": PACK, "num": mythic, "count": 1, "serial": serial });
    let r = call_key(&app, "POST", "/api/scrap", Some(&c), Some(body), Some(&Uuid::new_v4().to_string())).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["gained"], 600);
    assert!(r.body["collection"]["cards"].as_array().unwrap().iter().all(|x| x["num"] != mythic), "gone");
    let common = team_of("common", 7);
    give_card(&db, id, common, "common").await;
    let r = call(&app, "POST", "/api/scrap/extras", Some(&c), Some(json!({ "pack": PACK, "tiers": ["common"] }))).await;
    assert_eq!(r.body["scrapped"], 0);
}

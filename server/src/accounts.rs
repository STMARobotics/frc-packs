//! Accounts: usernames, passwords, sessions and invite codes. New accounts need an invite code; after that, people
//! sign in with their username and password on any device.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use rand::{Rng, RngCore};
use uuid::Uuid;

use crate::auth;
use crate::db::{Cond, Db, DbResult, Tx, get_s, key, n, pad, s};
use crate::model::{self, PackRow, Profile, now_ms};

/// Usernames: 3 to 20 letters, digits or underscores. Unique ignoring case.
pub fn valid_username(name: &str) -> bool {
    (3..=20).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Words no username may contain anywhere: slurs, profanity, and sexual or hateful terms. Usernames are public
/// (trades, profiles), and many players are students. Only roots that don't hide inside ordinary words.
const BLOCKED_ANYWHERE: &[&str] = &[
    "fuck",
    "fuk",
    "fck",
    "shit",
    "bitch",
    "cunt",
    "pussy",
    "asshole",
    "bastard",
    "whore",
    "slut",
    "nigg",
    "nigr",
    "faggot",
    "retard",
    "kike",
    "chink",
    "tranny",
    "wetback",
    "beaner",
    "hitler",
    "rapist",
    "molest",
    "porn",
    "penis",
    "vagina",
    "dildo",
    "jizz",
    "horny",
    "milf",
    "hentai",
    "killyourself",
];

/// Words blocked only as a whole word (split on underscores and digits), because they hide inside ordinary words:
/// grape, torpedo, spice, peacock, Dickens.
const BLOCKED_WORDS: &[&str] = &[
    "dick", "cock", "rape", "pedo", "spic", "gook", "fag", "nazi", "heil", "kkk", "tits", "boob", "boobs", "nude",
    "naked", "xxx", "kys", "cum", "sex", "sexy", "dyke", "semen", "anal", "ass", "piss",
];

/// False when a username contains a blocked word, also spelled with digits or symbols for letters (sh1t, b1tch) or
/// broken up with underscores (f_u_c_k).
pub fn decent_username(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let unleet: String = lower
        .chars()
        .map(|c| match c {
            '0' => 'o',
            '1' | '!' => 'i',
            '3' => 'e',
            '4' | '@' => 'a',
            '5' | '$' => 's',
            '7' => 't',
            '8' => 'b',
            c => c,
        })
        .collect();
    let squashed: String = unleet.chars().filter(|c| *c != '_').collect();
    if BLOCKED_ANYWHERE.iter().any(|w| lower.contains(w) || unleet.contains(w) || squashed.contains(w)) {
        return false;
    }
    // Whole words: the name split on underscores and digits (before digits become letters), and the whole name.
    let words: Vec<&str> = lower.split(|c: char| c == '_' || c.is_ascii_digit()).filter(|w| !w.is_empty()).collect();
    !BLOCKED_WORDS.iter().any(|w| words.contains(w) || squashed == *w || unleet.split('_').any(|p| p == *w))
}

pub fn valid_password(pw: &str) -> bool {
    (8..=128).contains(&pw.chars().count())
}

fn hash_password(pw: &str) -> String {
    let mut salt = [0u8; 16];
    rand::rng().fill_bytes(&mut salt);
    let salt = SaltString::encode_b64(&salt).expect("16 bytes is a valid salt");
    Argon2::default().hash_password(pw.as_bytes(), &salt).expect("argon2 accepts any password").to_string()
}

fn verify_password(pw: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| Argon2::default().verify_password(pw.as_bytes(), &h).is_ok())
}

/// A valid hash of a password nobody has, to check against when a username doesn't exist (so sign-in takes as long
/// either way).
pub fn decoy_hash() -> &'static str {
    static DECOY: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    DECOY.get_or_init(|| hash_password("no account has this password"))
}

/// Password hashing is slow on purpose (so stolen hashes are slow to crack); keep it off the request threads.
pub async fn hash(pw: String) -> String {
    tokio::task::spawn_blocking(move || hash_password(&pw)).await.expect("hashing doesn't panic")
}

pub async fn verify(pw: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || verify_password(&pw, &hash)).await.expect("verifying doesn't panic")
}

fn random_from(alphabet: &[u8], n: usize) -> String {
    let mut rng = rand::rng();
    (0..n).map(|_| alphabet[rng.random_range(0..alphabet.len())] as char).collect()
}

/// Groups of 4 with dashes, for reading out or typing.
fn grouped(s: &str) -> String {
    s.as_bytes().chunks(4).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join("-")
}

/// A new invite code: 12 characters with no look-alikes (no I, L, O, 0 or 1), about 59 bits. Stored without dashes.
pub fn new_invite_code() -> String {
    random_from(b"ABCDEFGHJKMNPQRSTUVWXYZ23456789", 12)
}

/// How an invite code is shown: ABCD-EFGH-JKMN.
pub fn show_code(code: &str) -> String {
    grouped(code)
}

/// What people type: any case, with or without dashes or spaces.
pub fn normalize_code(input: &str) -> String {
    input.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_uppercase()).collect()
}

/// A generated password for the admin account and for password resets: 16 lower-case characters, about 79 bits.
pub fn new_password() -> String {
    grouped(&random_from(b"abcdefghjkmnpqrstuvwxyz23456789", 16))
}

/// A new account's profile (not saved yet). Its first free pack is ready right away.
pub fn new_profile(username: &str, password_hash: &str, invite: Option<&str>, admin: bool) -> Profile {
    let now = now_ms();
    Profile {
        id: Uuid::new_v4(),
        username: Some(username.to_string()),
        password_hash: Some(password_hash.to_string()),
        is_admin: admin,
        invite_code: invite.map(String::from),
        next_claim_at: now,
        created_at: now,
        // A new account's cards are made with the current rarities, so it never needs bringing up to date.
        retier: crate::retier::VERSION,
        ..Default::default()
    }
}

/// Adds a new account to the transaction: the profile, its name (which must not be taken, label "name") and its
/// starting packs.
pub fn create(tx: &mut Tx, p: &mut Profile, start_pack: &str, start_packs: i32) {
    claim_name(tx, p.id, p.username.as_deref().unwrap_or_default());
    let before = PackRow::new(start_pack);
    let after = PackRow { sealed: start_packs, ..before.clone() };
    model::save_pack(tx, p.id, &before, &after, "new account");
    model::save_user(tx, p, 0, "new account");
}

fn name_pk(name: &str) -> String {
    format!("NAME#{}", name.to_lowercase())
}

/// Takes a username for an account; fails the transaction (label "name") if it's taken, ignoring case.
fn claim_name(tx: &mut Tx, user: Uuid, name: &str) {
    let mut it = key(name_pk(name), "NAME");
    it.insert("user_id".into(), s(user.to_string()));
    tx.put_if("name", it, Some(Cond::absent()));
}

/// Gives the player a new username in the transaction (the caller saves the profile). The old name is freed.
pub fn rename(tx: &mut Tx, p: &mut Profile, name: &str) {
    let old = p.username.clone().unwrap_or_default();
    if old.to_lowercase() != name.to_lowercase() {
        claim_name(tx, p.id, name);
        if !old.is_empty() {
            tx.delete_if("", &name_pk(&old), "NAME", Some(Cond::new("user_id = :me").val(":me", s(p.id.to_string()))));
        }
    }
    p.username = Some(name.to_string());
}

/// The account with this username, ignoring case.
pub async fn by_name(db: &Db, name: &str) -> DbResult<Option<Profile>> {
    let Some(it) = db.get(&name_pk(name.trim()), "NAME").await? else { return Ok(None) };
    let Some(id) = get_s(&it, "user_id").and_then(|v| Uuid::parse_str(&v).ok()) else { return Ok(None) };
    model::profile(db, id).await
}

/// Signs the account in on one more device (in the transaction) and returns the cookie token.
pub fn new_session(tx: &mut Tx, user: Uuid) -> String {
    let token = auth::new_token();
    let now = now_ms();
    let mut it = key(auth::session_pk(&token), "SESSION");
    it.insert("user_id".into(), s(user.to_string()));
    it.insert("created_at".into(), n(now));
    it.insert("expires_at".into(), n(now / 1000 + auth::SESSION_DAYS * 86_400));
    it.insert("gsi2pk".into(), s(model::upk(user)));
    it.insert("gsi2sk".into(), s(format!("SESSION#{now}")));
    tx.put(it);
    token
}

/// Signs the account out everywhere, except the session `keep` (its pk) if given.
pub async fn end_sessions(db: &Db, user: Uuid, keep: Option<&str>) -> DbResult<()> {
    for it in db.index("gsi2", &model::upk(user), None, false).await? {
        let pk = get_s(&it, "pk").unwrap_or_default();
        if get_s(&it, "sk").as_deref() == Some("SESSION") && Some(pk.as_str()) != keep {
            db.delete(&pk, "SESSION").await?;
        }
    }
    Ok(())
}

/// Saves an invite code.
pub async fn put_invite(db: &Db, code: &str, note: &str, max_uses: i32, by: Option<Uuid>) -> DbResult<()> {
    let now = now_ms();
    let mut it = key(format!("INV#{code}"), "INVITE");
    it.insert("code".into(), s(code));
    it.insert("note".into(), s(note));
    it.insert("max_uses".into(), n(max_uses));
    it.insert("uses".into(), n(0));
    it.insert("created_at".into(), n(now));
    if let Some(u) = by {
        it.insert("created_by".into(), s(u.to_string()));
    }
    it.insert("gsi1pk".into(), s("INVITES"));
    it.insert("gsi1sk".into(), s(format!("{}#{code}", pad(now, 15))));
    db.put(it).await
}

/// Counts failed sign-ins and invite codes, per username and per visitor, so passwords and codes can't be guessed by
/// brute force. Kept in memory: a restart clears it, which is fine for slowing guessing down.
#[derive(Default)]
pub struct Limiter {
    fails: Mutex<HashMap<String, (u32, Instant)>>,
}

const WINDOW: Duration = Duration::from_secs(15 * 60);

impl Limiter {
    /// True once `key` has failed `max` times within the last 15 minutes.
    pub fn blocked(&self, key: &str, max: u32) -> bool {
        let fails = self.fails.lock().unwrap();
        fails.get(key).is_some_and(|(n, since)| *n >= max && since.elapsed() < WINDOW)
    }

    pub fn fail(&self, key: &str) {
        let mut fails = self.fails.lock().unwrap();
        if fails.len() > 10_000 {
            fails.retain(|_, (_, since)| since.elapsed() < WINDOW);
        }
        let e = fails.entry(key.to_string()).or_insert((0, Instant::now()));
        if e.1.elapsed() >= WINDOW {
            *e = (0, Instant::now());
        }
        e.0 += 1;
    }

    pub fn clear(&self, key: &str) {
        self.fails.lock().unwrap().remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_filter() {
        for bad in
            ["fuckbot", "sh1tposter", "f_u_c_k", "B1TCH_x", "big_dick", "dick", "Nazi254", "sexy_robot", "xXx_420"]
        {
            assert!(!decent_username(bad), "{bad} should be blocked");
        }
        for ok in [
            "grapefruit",
            "torpedo_254",
            "spicy_bots",
            "peacock",
            "Dickens",
            "Cassie",
            "assembler",
            "classy",
            "cumulus",
            "Robo_Sexton",
            "analyst",
        ] {
            assert!(decent_username(ok), "{ok} should be allowed");
        }
    }

    #[test]
    fn passwords_hash_and_verify() {
        let h = hash_password("correct horse");
        assert!(h.starts_with("$argon2id$"));
        assert!(verify_password("correct horse", &h));
        assert!(!verify_password("wrong horse", &h));
        assert!(!verify_password("correct horse", "not a hash"));
    }

    #[test]
    fn codes_are_easy_to_type() {
        let c = new_invite_code();
        assert_eq!(c.len(), 12);
        assert!(!c.contains(['I', 'L', 'O', '0', '1']));
        assert_eq!(normalize_code(&show_code(&c).to_lowercase()), c);
        assert_eq!(normalize_code(" abcd efgh-jkmn "), "ABCDEFGHJKMN");
        assert_eq!(new_password().len(), 19);
    }

    #[test]
    fn usernames() {
        assert!(valid_username("cassie_7028"));
        for bad in ["ab", "a".repeat(21).as_str(), "has space", "dash-name", "émile"] {
            assert!(!valid_username(bad), "{bad}");
        }
    }

    #[test]
    fn limiter_blocks_after_max() {
        let l = Limiter::default();
        for _ in 0..3 {
            assert!(!l.blocked("k", 3));
            l.fail("k");
        }
        assert!(l.blocked("k", 3));
        assert!(!l.blocked("other", 3));
        l.clear("k");
        assert!(!l.blocked("k", 3));
    }
}

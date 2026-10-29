//! One Battler game as a state machine (spec §3, §6): OPEN -> DECKS -> DRAFT -> (PIT -> RESULTS) x 5 -> FINAL. Pure: the
//! server reads the game, calls one of these with the current time, and writes it back on condition nobody else changed
//! it first. Every shuffle and roll comes from the game's secret seed, so a refresh or a retry never re-rolls anything.
//! The seed's hash is shown from the start and the seed itself once the game is over, so players can check nothing was
//! changed along the way.

use rand::rngs::StdRng;
use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::content::{Kind, Robot, Support};
use super::effects::{Effect, Owner, describe};
use super::engine::{self, FieldLore, FieldPart, FieldRobot, RoundResult, Stats};

pub const ROUNDS: u8 = 5;
pub const DECK_ROBOTS: usize = 10;
pub const SUPPORT_CARDS: usize = 15;
pub const DRAW: usize = 3;
pub const MAX_COPIES: usize = 3;
/// How long the lobby waits for a second player, players get to pick decks, to finish the pit, and to look at results.
pub const OPEN_MS: i64 = 30 * 60_000;
pub const DECKS_MS: i64 = 5 * 60_000;
pub const PIT_MS: i64 = 5 * 60_000;
pub const RESULTS_MS: i64 = 2 * 60_000;
/// Time for each draft pick; missing it picks the first robot offered.
pub const DRAFT_MS: i64 = 45_000;
/// Extra time on the first pick, for the pre-game intro both players watch.
pub const INTRO_MS: i64 = 8_000;
/// Robots each player drafts into their pool, and how many are offered at a time.
pub const POOL_SIZE: usize = 10;
pub const OFFER: usize = 3;
/// A robot's battery: what a round on the field costs, what a round on the bench gives back, where a repaired robot
/// comes back at, and the chance (per mille) it breaks down: 4% when fresh, more as the battery runs down.
pub const DRAIN: i32 = 30;
pub const RECHARGE: i32 = 25;
pub const REPAIR_BATTERY: i32 = 60;
/// Misses of the draft timer that cancel the game.
pub const DRAFT_MISSES: u8 = 2;

/// Percent of its stats a robot has at this battery level.
pub fn power_for(battery: i32) -> i32 {
    match battery {
        50.. => 100,
        25..=49 => 85,
        _ => 65,
    }
}

/// Chance, per mille, that a robot with this battery breaks down during a round.
pub fn break_permille(battery: i32) -> u32 {
    (40 + (100 - battery.clamp(0, 100)) * 3 / 2) as u32
}
/// Missing this many pit deadlines forfeits the game.
pub const STRIKES: u8 = 2;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Status {
    Open,
    Decks,
    Draft,
    Pit,
    Results,
    Final,
    Cancelled,
}

impl Status {
    pub fn over(self) -> bool {
        matches!(self, Status::Final | Status::Cancelled)
    }
}

/// How a waiting game finds its second player.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Listed for anyone to join (games from before Quick Play).
    #[default]
    Open,
    /// In the Quick Play queue: the next player looking for a game takes it.
    Quick,
    /// Hosted for someone in particular: never listed, and only someone with its code can see or join it.
    Private,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RobotInst {
    pub inst: u32,
    pub card: String,
    pub team: i32,
    pub name: String,
    pub region: String,
    pub tier: String,
    pub photo: bool,
    pub stats: Stats,
    pub test_stats: bool,
    pub effects: Vec<Effect>,
    pub effect_text: String,
    /// The effect is one of the test examples, not an admin-published one.
    pub effect_test: bool,
    /// Whose deck it came from.
    pub from: usize,
    /// Charge left (a captain never runs down), and rounds still to sit out after a breakdown.
    #[serde(default = "full_battery")]
    pub battery: i32,
    #[serde(default)]
    pub broken: u8,
}

fn full_battery() -> i32 {
    100
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SupportInst {
    pub inst: u32,
    pub owner: usize,
    pub card: String,
    pub kind: Kind,
    pub name: String,
    pub tags: Vec<String>,
    pub effects: Vec<Effect>,
    pub text: String,
}

/// A robot as a deck brings it into a game: the card plus its effect at the moment the game starts.
#[derive(Clone, Debug)]
pub struct RobotPick {
    pub robot: Robot,
    pub effects: Vec<Effect>,
    pub effect_test: bool,
}

/// A validated, owned deck, frozen into the game when both players have picked.
#[derive(Clone, Debug)]
pub struct DeckPick {
    pub deck_id: String,
    pub captain: RobotPick,
    pub robots: Vec<RobotPick>,
    pub support: Vec<Support>,
}

/// What a player is setting up in the pit. Private until both lock.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Plan {
    /// (part instance, robot instance)
    pub attach: Vec<(u32, u32)>,
    pub lore: Option<u32>,
    /// The two robots from your pool that go out with your Captain this round.
    #[serde(default)]
    pub partners: [u32; 2],
    /// The robot in driver station 1, 2 and 3.
    pub stations: [u32; 3],
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Seat {
    pub uid: Uuid,
    pub name: String,
    pub elo: i32,
    pub deck_id: Option<String>,
    pub captain: u32,
    /// The robots drafted into this player's pool (public), not counting the Captain.
    #[serde(default)]
    pub pool: Vec<u32>,
    #[serde(default)]
    pub draft_misses: u8,
    /// Support cards not drawn yet, top first (private).
    pub pile: Vec<u32>,
    pub hand: Vec<u32>,
    pub plan: Plan,
    pub locked: bool,
    pub acked: bool,
    pub rp: i32,
    pub points: i32,
    pub strikes: u8,
}

impl Seat {
    pub fn new(uid: Uuid, name: String, elo: i32) -> Seat {
        Seat {
            uid,
            name,
            elo,
            deck_id: None,
            captain: 0,
            pool: vec![],
            draft_misses: 0,
            pile: vec![],
            hand: vec![],
            plan: Plan::default(),
            locked: false,
            acked: false,
            rp: 0,
            points: 0,
            strikes: 0,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RoundLog {
    pub round: u8,
    pub stations: [[u32; 3]; 2],
    pub attach: [Vec<(u32, u32)>; 2],
    pub lore: [Option<u32>; 2],
    pub result: RoundResult,
    /// Seats that were locked automatically when the pit timer ran out.
    #[serde(default)]
    pub auto_locked: [bool; 2],
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Outcome {
    pub winner: Option<usize>,
    /// "complete", "forfeit" or "timeout".
    pub reason: String,
    pub rp: [i32; 2],
    pub points: [i32; 2],
    pub elo_before: [i32; 2],
    pub elo_after: [i32; 2],
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Game {
    pub id: String,
    pub created_at: i64,
    pub status: Status,
    pub rev: u64,
    pub seats: [Option<Seat>; 2],
    /// Picked decks waiting for the other player (not shown to anyone).
    #[serde(default)]
    pub picks: [Option<PickSnap>; 2],
    pub robots: Vec<RobotInst>,
    pub support: Vec<SupportInst>,
    /// The shuffled robots still to be drafted, top first (private except the current offer).
    pub pool: Vec<u32>,
    /// The robots on offer to whoever drafts next (public): the top of `pool`.
    #[serde(default)]
    pub offer: Vec<u32>,
    /// Picks made so far, and who picked first.
    #[serde(default)]
    pub draft_turn: u8,
    #[serde(default)]
    pub draft_first: usize,
    pub round: u8,
    /// This round's robots per side: captain first.
    pub alliances: [[u32; 3]; 2],
    pub rounds: Vec<RoundLog>,
    pub seed: u64,
    pub seed_hash: String,
    pub deadline: i64,
    pub outcome: Option<Outcome>,
    pub engine: u32,
    /// The latest quick-chat emotes (newest last). They don't change the game, so they don't bump `rev`.
    #[serde(default)]
    pub emotes: Vec<Emote>,
    #[serde(default)]
    pub emote_seq: u64,
    #[serde(default)]
    pub mode: Mode,
    /// A private game's invite code (empty for the others).
    #[serde(default)]
    pub code: String,
    /// A wager on the match (see crate::wagers): none, stakes on the table (the match waits for them to be agreed or
    /// called off), or locked in escrow.
    #[serde(default)]
    pub wager: Wager,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Wager {
    #[default]
    None,
    Open,
    Locked,
}

/// The quick-chat emotes a player can send during a game.
pub const EMOTES: &[&str] = &["gg", "nice", "oops", "wow", "thinking", "hello"];
/// At most one emote per player this often.
pub const EMOTE_GAP_MS: i64 = 2_000;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Emote {
    pub side: usize,
    pub id: String,
    pub at: i64,
    pub n: u64,
}

/// A deck pick as stored until the game starts.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PickSnap {
    pub deck_id: String,
    pub robots: Vec<RobotSnap>,
    pub support: Vec<Support>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RobotSnap {
    pub robot: Robot,
    pub effects: Vec<Effect>,
    pub effect_test: bool,
}

/// Why an action was refused (the site shows these).
pub type Refusal = &'static str;

pub fn seed_hash(seed: u64) -> String {
    hex::encode(Sha256::digest(seed.to_le_bytes()))
}

/// The seed for one round's rolls, from the game seed (so rounds don't share rolls).
fn round_seed(seed: u64, round: u8) -> u64 {
    let d = Sha256::digest([seed.to_le_bytes().as_slice(), &[round]].concat());
    u64::from_le_bytes(d[..8].try_into().unwrap())
}

impl Game {
    pub fn new(id: String, host: Seat, seed: u64, now: i64) -> Game {
        Game {
            id,
            created_at: now,
            status: Status::Open,
            rev: 1,
            seats: [Some(host), None],
            picks: [None, None],
            robots: vec![],
            support: vec![],
            pool: vec![],
            offer: vec![],
            draft_turn: 0,
            draft_first: 0,
            round: 0,
            alliances: [[0; 3]; 2],
            rounds: vec![],
            seed,
            seed_hash: seed_hash(seed),
            deadline: now + OPEN_MS,
            outcome: None,
            engine: engine::ENGINE_VERSION,
            emotes: vec![],
            emote_seq: 0,
            mode: Mode::Open,
            code: String::new(),
            wager: Wager::None,
        }
    }

    pub fn seat(&self, side: usize) -> &Seat {
        self.seats[side].as_ref().expect("both seats are filled after OPEN")
    }

    fn seat_mut(&mut self, side: usize) -> &mut Seat {
        self.seats[side].as_mut().expect("both seats are filled after OPEN")
    }

    /// Which side a player sits on.
    pub fn side_of(&self, uid: Uuid) -> Option<usize> {
        self.seats.iter().position(|s| s.as_ref().is_some_and(|s| s.uid == uid))
    }

    pub fn robot(&self, inst: u32) -> Option<&RobotInst> {
        self.robots.iter().find(|r| r.inst == inst)
    }

    pub fn card(&self, inst: u32) -> Option<&SupportInst> {
        self.support.iter().find(|c| c.inst == inst)
    }

    fn bump(&mut self) {
        self.rev += 1;
    }

    pub fn join(&mut self, guest: Seat, now: i64) -> Result<(), Refusal> {
        if self.status != Status::Open {
            return Err("game_full");
        }
        if self.seats[0].as_ref().is_some_and(|h| h.uid == guest.uid) {
            return Err("own_game");
        }
        self.seats[1] = Some(guest);
        self.status = Status::Decks;
        self.deadline = now + DECKS_MS;
        self.bump();
        Ok(())
    }

    /// The host leaves before anyone joins.
    pub fn cancel(&mut self, side: usize) -> Result<(), Refusal> {
        if self.status != Status::Open || side != 0 {
            return Err("cant_cancel");
        }
        self.status = Status::Cancelled;
        self.bump();
        Ok(())
    }

    pub fn pick_deck(&mut self, side: usize, pick: DeckPick, now: i64) -> Result<(), Refusal> {
        if self.status != Status::Decks {
            return Err("not_picking");
        }
        if self.picks[side].is_some() {
            return Err("already_picked");
        }
        let snap = |p: RobotPick| RobotSnap { robot: p.robot, effects: p.effects, effect_test: p.effect_test };
        let mut robots = vec![snap(pick.captain)];
        robots.extend(pick.robots.into_iter().map(snap));
        self.seat_mut(side).deck_id = Some(pick.deck_id.clone());
        self.picks[side] = Some(PickSnap { deck_id: pick.deck_id, robots, support: pick.support });
        self.bump();
        self.start_if_ready(now);
        Ok(())
    }

    /// Starts once both decks are picked, unless a wager is still being agreed.
    fn start_if_ready(&mut self, now: i64) {
        if self.status == Status::Decks && self.picks.iter().all(Option::is_some) && self.wager != Wager::Open {
            self.start(now);
        }
    }

    /// Stakes went on the table (`open`) or came off it. Only in a private match, before it starts.
    pub fn set_wager(&mut self, open: bool, now: i64) -> Result<(), Refusal> {
        if self.mode != Mode::Private || self.status != Status::Decks || self.wager == Wager::Locked {
            return Err("no_wager_here");
        }
        self.wager = if open { Wager::Open } else { Wager::None };
        self.bump();
        self.start_if_ready(now);
        Ok(())
    }

    /// Both players agreed and the stakes are in escrow.
    pub fn lock_wager(&mut self, now: i64) -> Result<(), Refusal> {
        if self.status != Status::Decks || self.wager != Wager::Open {
            return Err("no_wager_here");
        }
        self.wager = Wager::Locked;
        self.bump();
        self.start_if_ready(now);
        Ok(())
    }

    /// Robots (by team) in the deck a player picked, for a pink slip.
    pub fn deck_teams(&self, side: usize) -> Option<Vec<i32>> {
        self.picks[side].as_ref().map(|p| p.robots.iter().map(|r| r.robot.team).collect())
    }

    /// Both decks are in: freeze them, shuffle the Alliance Deck and both Support Decks, deal round 1.
    fn start(&mut self, now: i64) {
        let mut rng = StdRng::seed_from_u64(self.seed);
        let mut next = 1u32;
        let picks = [self.picks[0].take().unwrap(), self.picks[1].take().unwrap()];
        let mut pool = vec![];
        for (side, p) in picks.iter().enumerate() {
            for (k, r) in p.robots.iter().enumerate() {
                let inst = next;
                next += 1;
                self.robots.push(RobotInst {
                    inst,
                    card: r.robot.id.clone(),
                    team: r.robot.team,
                    name: r.robot.name.clone(),
                    region: r.robot.region.clone(),
                    tier: r.robot.tier.clone(),
                    photo: r.robot.photo,
                    stats: r.robot.stats,
                    test_stats: r.robot.test_stats,
                    effect_text: if r.effects.is_empty() { String::new() } else { describe(&r.effects, Owner::Robot) },
                    effects: r.effects.clone(),
                    effect_test: r.effect_test,
                    from: side,
                    battery: 100,
                    broken: 0,
                });
                if k == 0 {
                    self.seat_mut(side).captain = inst;
                } else {
                    pool.push(inst);
                }
            }
        }
        pool.shuffle(&mut rng);
        self.pool = pool;
        for side in 0..2 {
            self.alliances[side] = [self.seat(side).captain, 0, 0];
        }
        let mut inst = 1000u32;
        for (side, p) in picks.iter().enumerate() {
            let mut pile = vec![];
            for c in &p.support {
                self.support.push(SupportInst {
                    inst,
                    owner: side,
                    card: c.id.clone(),
                    kind: c.kind.clone(),
                    name: c.name.clone(),
                    tags: c.tags.clone(),
                    effects: c.effects.clone(),
                    text: c.text.clone(),
                });
                pile.push(inst);
                inst += 1;
            }
            pile.shuffle(&mut rng);
            self.seat_mut(side).pile = pile;
        }
        // The shuffled robots of both decks are drafted in turns: three on offer, you take one, the other two go back.
        self.draft_first = rng.random_range(0..2);
        self.draft_turn = 0;
        self.offer = self.pool.iter().take(OFFER).copied().collect();
        self.status = Status::Draft;
        // The first pick gets a few extra seconds for the pre-game intro.
        self.deadline = now + DRAFT_MS + INTRO_MS;
        self.bump();
    }

    /// Whose turn it is to draft.
    pub fn draft_side(&self) -> usize {
        (self.draft_first + usize::from(self.draft_turn)) % 2
    }

    pub fn draft_pick(&mut self, side: usize, robot: u32, now: i64) -> Result<(), Refusal> {
        if self.status != Status::Draft {
            return Err("not_drafting");
        }
        if side != self.draft_side() {
            return Err("not_your_turn");
        }
        if !self.offer.contains(&robot) {
            return Err("not_offered");
        }
        self.take_draft(robot, now);
        Ok(())
    }

    fn take_draft(&mut self, robot: u32, now: i64) {
        let side = self.draft_side();
        let n = self.offer.len();
        let unpicked: Vec<u32> = self.offer.iter().copied().filter(|r| *r != robot).collect();
        self.pool.drain(..n).for_each(drop);
        self.pool.extend(unpicked);
        self.seat_mut(side).pool.push(robot);
        self.draft_turn += 1;
        if usize::from(self.draft_turn) >= 2 * POOL_SIZE {
            self.offer.clear();
            self.deal(now);
        } else {
            self.offer = self.pool.iter().take(OFFER).copied().collect();
            self.deadline = now + DRAFT_MS;
            self.bump();
        }
    }

    /// Your partners when you don't choose: last round's pair if they're still fit to go (not broken, still at full
    /// power), otherwise the charged, ready robots in your pool.
    fn default_partners(&self, side: usize) -> [u32; 2] {
        let seat = self.seat(side);
        let fit = |i: u32| self.robot(i).is_some_and(|r| r.broken == 0 && power_for(r.battery) == 100);
        let mut chosen: Vec<u32> = seat.plan.partners.iter().copied().filter(|i| *i != 0 && fit(*i)).collect();
        let mut ready: Vec<&RobotInst> =
            seat.pool.iter().filter_map(|i| self.robot(*i)).filter(|r| r.broken == 0).collect();
        ready.sort_by(|a, b| b.battery.cmp(&a.battery).then(a.inst.cmp(&b.inst)));
        for r in ready {
            if chosen.len() == 2 {
                break;
            }
            if !chosen.contains(&r.inst) {
                chosen.push(r.inst);
            }
        }
        [chosen[0], chosen[1]]
    }

    fn deal(&mut self, now: i64) {
        self.round += 1;
        for side in 0..2 {
            let [a, b] = self.default_partners(side);
            let captain = self.seat(side).captain;
            self.alliances[side] = [captain, a, b];
            let seat = self.seat_mut(side);
            for _ in 0..DRAW {
                if !seat.pile.is_empty() {
                    let c = seat.pile.remove(0);
                    seat.hand.push(c);
                }
            }
            seat.plan = Plan { attach: vec![], lore: None, partners: [a, b], stations: [captain, a, b] };
            seat.locked = false;
            seat.acked = false;
        }
        self.status = Status::Pit;
        self.deadline = now + PIT_MS;
        self.bump();
    }

    fn pit_check(&self, side: usize) -> Result<(), Refusal> {
        if self.status != Status::Pit {
            return Err("not_pit");
        }
        if self.seat(side).locked {
            return Err("locked");
        }
        Ok(())
    }

    /// Attaches a part from your hand to one of your three robots (moving it if it was on another).
    pub fn attach(&mut self, side: usize, part: u32, robot: u32) -> Result<(), Refusal> {
        self.pit_check(side)?;
        let seat = self.seat(side);
        if !seat.hand.contains(&part) || self.card(part).is_none_or(|c| c.kind != Kind::Part) {
            return Err("not_in_hand");
        }
        if !self.alliances[side].contains(&robot) {
            return Err("not_your_robot");
        }
        let seat = self.seat_mut(side);
        seat.plan.attach.retain(|(p, _)| *p != part);
        seat.plan.attach.push((part, robot));
        self.bump();
        Ok(())
    }

    pub fn detach(&mut self, side: usize, part: u32) -> Result<(), Refusal> {
        self.pit_check(side)?;
        let seat = self.seat_mut(side);
        let before = seat.plan.attach.len();
        seat.plan.attach.retain(|(p, _)| *p != part);
        if seat.plan.attach.len() == before {
            return Err("not_attached");
        }
        self.bump();
        Ok(())
    }

    /// Picks this round's lore card from your hand, or none. One per player per round.
    pub fn set_lore(&mut self, side: usize, lore: Option<u32>) -> Result<(), Refusal> {
        self.pit_check(side)?;
        if let Some(l) = lore
            && (!self.seat(side).hand.contains(&l) || self.card(l).is_none_or(|c| c.kind != Kind::Lore))
        {
            return Err("not_in_hand");
        }
        self.seat_mut(side).plan.lore = lore;
        self.bump();
        Ok(())
    }

    /// Chooses the two robots from your pool that go out with your Captain this round. Robots that are broken can't go.
    /// Changing partners puts everyone back in station order and takes parts off any robot that's no longer on the field.
    pub fn set_partners(&mut self, side: usize, partners: [u32; 2]) -> Result<(), Refusal> {
        self.pit_check(side)?;
        if partners[0] == partners[1] {
            return Err("bad_partners");
        }
        for p in partners {
            if !self.seat(side).pool.contains(&p) {
                return Err("not_in_pool");
            }
            if self.robot(p).is_none_or(|r| r.broken > 0) {
                return Err("broken");
            }
        }
        let captain = self.seat(side).captain;
        let seat = self.seat_mut(side);
        seat.plan.partners = partners;
        seat.plan.stations = [captain, partners[0], partners[1]];
        let field = [captain, partners[0], partners[1]];
        seat.plan.attach.retain(|(_, r)| field.contains(r));
        self.alliances[side] = field;
        self.bump();
        Ok(())
    }

    /// Puts your three robots in driver stations 1, 2 and 3 (each robot once).
    pub fn set_stations(&mut self, side: usize, stations: [u32; 3]) -> Result<(), Refusal> {
        self.pit_check(side)?;
        let mut a = self.alliances[side];
        let mut b = stations;
        a.sort_unstable();
        b.sort_unstable();
        if a != b {
            return Err("bad_stations");
        }
        self.seat_mut(side).plan.stations = stations;
        self.bump();
        Ok(())
    }

    pub fn lock(&mut self, side: usize, now: i64) -> Result<(), Refusal> {
        self.pit_check(side)?;
        self.seat_mut(side).locked = true;
        self.bump();
        if self.seat(1 - side).locked {
            self.resolve(now, [false, false]);
        }
        Ok(())
    }

    /// Both alliances are locked: reveal and score the round.
    fn resolve(&mut self, now: i64, auto_locked: [bool; 2]) {
        let mut field = vec![];
        let mut lores = vec![];
        // Breakdown rolls come from their own seeded stream, in station order, so a refresh never re-rolls them.
        let mut brk = StdRng::seed_from_u64(round_seed(self.seed, self.round) ^ 0xB4EA_C0DE);
        for side in 0..2 {
            let seat = self.seat(side).clone();
            for (k, &inst) in seat.plan.stations.iter().enumerate() {
                let r = self.robot(inst).expect("robot in game");
                let parts = seat
                    .plan
                    .attach
                    .iter()
                    .filter(|(_, rb)| *rb == inst)
                    .filter_map(|(p, _)| self.card(*p))
                    .map(|c| FieldPart {
                        inst: c.inst,
                        name: c.name.clone(),
                        tags: c.tags.clone(),
                        effects: c.effects.clone(),
                    })
                    .collect();
                let captain = inst == seat.captain;
                let battery = if captain { 100 } else { r.battery };
                let breaks = !captain && brk.random_range(0..1000u32) < break_permille(battery);
                field.push(FieldRobot {
                    inst,
                    name: format!("{} {}", r.team, r.name),
                    side,
                    captain,
                    station: k as u8 + 1,
                    stats: r.stats,
                    power: if captain { 100 } else { power_for(battery) },
                    battery,
                    breaks,
                    effects: r.effects.clone(),
                    parts,
                });
            }
            if let Some(l) = seat.plan.lore.and_then(|l| self.card(l)) {
                lores.push(FieldLore { inst: l.inst, name: l.name.clone(), side, effects: l.effects.clone() });
            }
        }
        let result = engine::resolve(&field, &lores, round_seed(self.seed, self.round));
        let log = RoundLog {
            round: self.round,
            stations: [self.seat(0).plan.stations, self.seat(1).plan.stations],
            attach: [self.seat(0).plan.attach.clone(), self.seat(1).plan.attach.clone()],
            lore: [self.seat(0).plan.lore, self.seat(1).plan.lore],
            result: result.clone(),
            auto_locked,
        };
        // Batteries: robots on the field spend charge (and a broken one is out next round), the bench recharges, and a
        // robot that sat out its repair comes back at 60%. A Captain never runs down.
        for side in 0..2 {
            let fielded = self.seat(side).plan.stations;
            for inst in self.seat(side).pool.clone() {
                let broke = result.robots.iter().any(|s| s.inst == inst && s.broke);
                let r = self.robots.iter_mut().find(|r| r.inst == inst).expect("pool robot in game");
                if fielded.contains(&inst) {
                    r.battery = (r.battery - DRAIN).max(0);
                    if broke {
                        r.broken = 1;
                    }
                } else if r.broken > 0 {
                    r.broken -= 1;
                    if r.broken == 0 {
                        r.battery = REPAIR_BATTERY;
                    }
                } else {
                    r.battery = (r.battery + RECHARGE).min(100);
                }
            }
        }
        for side in 0..2 {
            let seat = self.seat_mut(side);
            seat.rp += result.match_rp[side] + result.bonus_rp[side];
            seat.points += result.totals[side];
            // Played parts and lore are used up for this game (never taken from the FRC Packs collection).
            let used: Vec<u32> = seat.plan.attach.iter().map(|(p, _)| *p).chain(seat.plan.lore).collect();
            seat.hand.retain(|c| !used.contains(c));
            seat.acked = false;
        }
        self.rounds.push(log);
        self.status = Status::Results;
        self.deadline = now + RESULTS_MS;
        self.bump();
    }

    /// Done looking at the results. When both are, the next round is dealt (or the game ends after round 5).
    pub fn ack(&mut self, side: usize, now: i64) -> Result<(), Refusal> {
        if self.status != Status::Results {
            return Err("not_results");
        }
        if self.seat(side).acked {
            return Ok(());
        }
        self.seat_mut(side).acked = true;
        self.bump();
        if self.seat(1 - side).acked {
            self.advance(now);
        }
        Ok(())
    }

    fn advance(&mut self, now: i64) {
        if self.round >= ROUNDS {
            self.finish(None, "complete");
        } else {
            self.deal(now);
        }
    }

    /// Sends a quick-chat emote (only while both players are in the game).
    pub fn emote(&mut self, side: usize, id: &str, now: i64) -> Result<(), Refusal> {
        if self.status.over() || self.status == Status::Open {
            return Err("game_over");
        }
        if !EMOTES.contains(&id) {
            return Err("bad_emote");
        }
        if self.emotes.iter().any(|e| e.side == side && now - e.at < EMOTE_GAP_MS) {
            return Err("too_fast");
        }
        self.emote_seq += 1;
        self.emotes.push(Emote { side, id: id.to_string(), at: now, n: self.emote_seq });
        if self.emotes.len() > 6 {
            self.emotes.remove(0);
        }
        Ok(())
    }

    pub fn forfeit(&mut self, side: usize) -> Result<(), Refusal> {
        match self.status {
            Status::Decks | Status::Draft => {
                // Nothing played yet: call it off, no rating change.
                self.status = Status::Cancelled;
                self.bump();
                Ok(())
            }
            Status::Pit | Status::Results => {
                self.finish(Some(1 - side), "forfeit");
                Ok(())
            }
            _ => Err("cant_forfeit"),
        }
    }

    /// Ends the game. `winner_by` forces a winner (forfeits); otherwise most RP wins, then most points, else a draw.
    /// Ratings are filled in by the caller ([`Game::rate`]) in the same write.
    fn finish(&mut self, winner_by: Option<usize>, reason: &str) {
        let rp = [self.seat(0).rp, self.seat(1).rp];
        let points = [self.seat(0).points, self.seat(1).points];
        let winner = winner_by.or_else(|| match rp[0].cmp(&rp[1]).then(points[0].cmp(&points[1])) {
            std::cmp::Ordering::Greater => Some(0),
            std::cmp::Ordering::Less => Some(1),
            std::cmp::Ordering::Equal => None,
        });
        let before = [self.seat(0).elo, self.seat(1).elo];
        self.outcome =
            Some(Outcome { winner, reason: reason.into(), rp, points, elo_before: before, elo_after: before });
        self.status = Status::Final;
        self.deadline = 0;
        self.bump();
    }

    /// Works out the new ratings from the ratings the players have right now (once, when the game ends).
    pub fn rate(&mut self, current: [i32; 2]) -> [i32; 2] {
        let o = self.outcome.as_mut().expect("rated after finishing");
        let score = |side: usize| match o.winner {
            Some(w) if w == side => 1.0,
            Some(_) => 0.0,
            None => 0.5,
        };
        let after = [engine::elo(current[0], current[1], score(0)), engine::elo(current[1], current[0], score(1))];
        o.elo_before = current;
        o.elo_after = after;
        after
    }

    /// Applies any deadline that has passed. Returns whether anything changed.
    pub fn tick(&mut self, now: i64) -> bool {
        if self.status.over() || self.deadline == 0 || now < self.deadline {
            return false;
        }
        match self.status {
            Status::Open | Status::Decks => {
                self.status = Status::Cancelled;
                self.bump();
            }
            Status::Draft => {
                // A missed pick takes the first robot offered; missing two in a row-ish cancels the game.
                let side = self.draft_side();
                self.seat_mut(side).draft_misses += 1;
                if self.seat(side).draft_misses >= DRAFT_MISSES {
                    self.status = Status::Cancelled;
                    self.bump();
                } else {
                    let robot = self.offer[0];
                    self.take_draft(robot, now);
                }
            }
            Status::Pit => {
                let late: Vec<usize> = (0..2).filter(|&s| !self.seat(s).locked).collect();
                for &s in &late {
                    self.seat_mut(s).strikes += 1;
                }
                let out: Vec<usize> = late.iter().copied().filter(|&s| self.seat(s).strikes >= STRIKES).collect();
                match out.as_slice() {
                    [] => {
                        let mut auto = [false; 2];
                        for &s in &late {
                            self.seat_mut(s).locked = true;
                            auto[s] = true;
                        }
                        self.resolve(now, auto);
                    }
                    [s] => self.finish(Some(1 - *s), "timeout"),
                    _ => {
                        // Both walked away: nobody wins, no rating change.
                        self.status = Status::Cancelled;
                        self.bump();
                    }
                }
            }
            Status::Results => {
                for s in 0..2 {
                    self.seat_mut(s).acked = true;
                }
                self.advance(now);
            }
            Status::Final | Status::Cancelled => return false,
        }
        true
    }
}

// ---------- what each player may see ----------

#[derive(Serialize)]
pub struct SeatView {
    pub name: String,
    pub elo: i32,
    pub picked: bool,
    pub locked: bool,
    pub acked: bool,
    pub rp: i32,
    pub points: i32,
    pub hand_count: usize,
    pub pile_count: usize,
    pub strikes: u8,
    /// During the pit: how many parts this player has put down (face down: not which cards, not on which robots).
    pub parts_down: usize,
    /// During the pit: whether they've put a lore card down (not which).
    pub lore_down: bool,
    /// The robots they drafted (public).
    pub pool: Vec<u32>,
}

#[derive(Serialize)]
pub struct MeView {
    pub side: usize,
    pub hand: Vec<u32>,
    pub plan: Plan,
}

#[derive(Serialize)]
pub struct GameView<'a> {
    pub id: &'a str,
    pub rev: u64,
    pub status: Status,
    pub round: u8,
    pub rounds_total: u8,
    pub deadline: i64,
    pub seats: Vec<Option<SeatView>>,
    pub me: Option<MeView>,
    /// Each side's Captain and two partners this round. The other player's partners stay 0 until the round is revealed.
    pub alliances: [[u32; 3]; 2],
    pub pool_left: usize,
    /// The draft: robots on offer, picks made, whose pick it is.
    pub offer: &'a [u32],
    pub draft_turn: u8,
    pub draft_total: usize,
    pub draft_side: Option<usize>,
    /// Every robot this player may see: captains, both pools, the current offer, and revealed alliances.
    pub robots: Vec<&'a RobotInst>,
    /// Every support card this player may see: their own, and the opponent's once played.
    pub support: Vec<&'a SupportInst>,
    pub rounds: &'a [RoundLog],
    pub seed_hash: &'a str,
    /// Shown once the game is over, to check every shuffle and roll against `seed_hash`.
    pub seed: Option<String>,
    pub outcome: Option<&'a Outcome>,
    pub engine: u32,
    pub emotes: &'a [Emote],
    pub emote_seq: u64,
    pub mode: Mode,
    pub wager: Wager,
    /// A private game's invite code, for its players.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'a str>,
    /// The server's clock (ms) when this view was made, so timers line up with the server's (set by the API).
    pub now: i64,
}

impl Game {
    /// The game as `viewer` may see it: the opponent's hand, draw pile, pending pit plan and the undealt Alliance Deck
    /// stay hidden.
    pub fn view(&self, viewer: Option<usize>) -> GameView<'_> {
        let started = !self.robots.is_empty();
        let pit = self.status == Status::Pit;
        let seats = self
            .seats
            .iter()
            .map(|s| {
                s.as_ref().map(|s| SeatView {
                    name: s.name.clone(),
                    elo: s.elo,
                    picked: s.deck_id.is_some(),
                    locked: s.locked,
                    acked: s.acked,
                    rp: s.rp,
                    points: s.points,
                    // Cards already put down in the pit have left the hand, as far as anyone watching can tell.
                    hand_count: s.hand.len()
                        - if pit { s.plan.attach.len() + usize::from(s.plan.lore.is_some()) } else { 0 },
                    pile_count: s.pile.len(),
                    strikes: s.strikes,
                    parts_down: if pit { s.plan.attach.len() } else { 0 },
                    lore_down: pit && s.plan.lore.is_some(),
                    pool: s.pool.clone(),
                })
            })
            .collect();
        let me = viewer.and_then(|v| self.seats[v].as_ref().map(|s| (v, s))).map(|(v, s)| MeView {
            side: v,
            hand: s.hand.clone(),
            plan: s.plan.clone(),
        });
        // In the pit each player's partners are hidden from the other until both lock.
        let mut alliances = self.alliances;
        if pit {
            for (side, a) in alliances.iter_mut().enumerate() {
                if viewer != Some(side) {
                    a[1] = 0;
                    a[2] = 0;
                }
            }
        }
        let mut seen: Vec<u32> = vec![];
        if started {
            for s in self.seats.iter().flatten() {
                seen.push(s.captain);
            }
            for a in &alliances {
                seen.extend(a.iter().copied().filter(|i| *i != 0));
            }
            for s in self.seats.iter().flatten() {
                seen.extend(s.pool.iter().copied());
            }
            seen.extend(self.offer.iter().copied());
            for log in &self.rounds {
                seen.extend(log.stations.iter().flatten().copied());
            }
        }
        let over = self.status.over();
        let robots = self.robots.iter().filter(|r| over || seen.contains(&r.inst)).collect();
        let played: Vec<u32> = self
            .rounds
            .iter()
            .flat_map(|r| r.attach.iter().flatten().map(|(p, _)| *p).chain(r.lore.iter().flatten().copied()))
            .collect();
        let support = self.support.iter().filter(|c| Some(c.owner) == viewer || played.contains(&c.inst)).collect();
        GameView {
            id: &self.id,
            rev: self.rev,
            status: self.status,
            round: self.round,
            rounds_total: ROUNDS,
            deadline: self.deadline,
            seats,
            me,
            alliances,
            pool_left: self.pool.len(),
            offer: &self.offer,
            draft_turn: self.draft_turn,
            draft_total: 2 * POOL_SIZE,
            draft_side: (self.status == Status::Draft).then(|| self.draft_side()),
            robots,
            support,
            rounds: &self.rounds,
            seed_hash: &self.seed_hash,
            seed: over.then(|| self.seed.to_string()),
            outcome: self.outcome.as_ref(),
            engine: self.engine,
            emotes: &self.emotes,
            emote_seq: self.emote_seq,
            mode: self.mode,
            wager: self.wager,
            // Only the players see the invite code (someone joining already has it).
            code: (viewer.is_some() && !self.code.is_empty()).then_some(self.code.as_str()),
            now: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::battler::content::test_stats;

    fn robot(team: i32) -> RobotPick {
        RobotPick {
            robot: Robot {
                id: format!("R-2026-{team}"),
                team,
                name: format!("Team {team}"),
                season: 2026,
                region: "Minnesota".into(),
                tier: "common".into(),
                photo: false,
                stats: test_stats(team, Some(120.0)),
                test_stats: true,
            },
            effects: vec![],
            effect_test: false,
        }
    }

    fn part(i: usize) -> Support {
        Support {
            id: format!("P-{i}"),
            kind: if i.is_multiple_of(5) { Kind::Lore } else { Kind::Part },
            name: format!("Card {i}"),
            season: 2026,
            tags: if i.is_multiple_of(5) { vec![] } else { vec!["MECHANICAL".into()] },
            effects: serde_json::from_str(r#"[{"op":"ADD_PHASE_FLAT","phase":"TELE","value":5,"scope":"ALLIES"}]"#)
                .unwrap(),
            text: String::new(),
            flavor: String::new(),
            draft: true,
        }
    }

    fn deck(base: i32) -> DeckPick {
        DeckPick {
            deck_id: format!("d{base}"),
            captain: robot(base),
            robots: (1..=10).map(|i| robot(base + i)).collect(),
            support: (0..15).map(part).collect(),
        }
    }

    fn started() -> (Game, Uuid, Uuid) {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let mut g = Game::new("g1".into(), Seat::new(a, "alice".into(), 1000), 12345, 0);
        g.join(Seat::new(b, "bob".into(), 1000), 1).unwrap();
        g.pick_deck(0, deck(100), 2).unwrap();
        g.pick_deck(1, deck(200), 3).unwrap();
        (g, a, b)
    }

    /// Takes the first robot offered, for whoever's turn it is, until the draft is over.
    fn draft_all(g: &mut Game) {
        while g.status == Status::Draft {
            let (side, robot) = (g.draft_side(), g.offer[0]);
            g.draft_pick(side, robot, 5).unwrap();
        }
    }

    fn drafted() -> (Game, Uuid, Uuid) {
        let (mut g, a, b) = started();
        draft_all(&mut g);
        (g, a, b)
    }

    #[test]
    fn the_draft_alternates_and_fills_both_pools() {
        let (mut g, _, _) = started();
        assert_eq!(g.status, Status::Draft);
        assert_eq!(g.pool.len(), 20);
        assert_eq!(g.offer.len(), OFFER);
        let first = g.draft_side();
        let other = 1 - first;
        let robot = g.offer[1];
        assert_eq!(g.draft_pick(other, robot, 5), Err("not_your_turn"));
        assert_eq!(g.draft_pick(first, 9999, 5), Err("not_offered"));
        let left: Vec<u32> = g.offer.iter().copied().filter(|r| *r != robot).collect();
        g.draft_pick(first, robot, 5).unwrap();
        assert_eq!(g.seat(first).pool, vec![robot]);
        assert_eq!(g.draft_side(), other, "turns alternate");
        assert!(left.iter().all(|r| g.pool.contains(r)), "the two you passed on go back in the deck");
        assert!(!g.offer.contains(&robot));
        draft_all(&mut g);
        assert_eq!(g.status, Status::Pit);
        assert_eq!(g.round, 1);
        for side in 0..2 {
            assert_eq!(g.seat(side).pool.len(), POOL_SIZE);
        }
        let mut all: Vec<u32> = g.seats.iter().flatten().flat_map(|s| s.pool.clone()).collect();
        all.sort_unstable();
        all.dedup();
        assert_eq!(all.len(), 20, "every robot went to exactly one player");
    }

    #[test]
    fn missing_a_draft_pick_takes_the_first_offer_and_two_misses_cancel() {
        let (mut g, _, _) = started();
        let (side, first) = (g.draft_side(), g.offer[0]);
        let mut now = g.deadline + 1;
        assert!(g.tick(now));
        assert_eq!(g.seat(side).pool, vec![first]);
        assert_eq!(g.status, Status::Draft);
        // The other player picks, then the first misses again.
        let (s2, r2) = (g.draft_side(), g.offer[0]);
        g.draft_pick(s2, r2, now).unwrap();
        now += DRAFT_MS + 1;
        assert!(g.tick(now));
        assert_eq!(g.seat(side).draft_misses, 2);
        assert_eq!(g.status, Status::Cancelled);
    }

    #[test]
    fn a_full_game_runs_five_rounds_with_batteries() {
        let (mut g, _, _) = drafted();
        assert_eq!(g.status, Status::Pit);
        for round in 1..=ROUNDS {
            assert_eq!(g.round, round);
            for side in 0..2 {
                assert_eq!(g.alliances[side][0], g.seat(side).captain, "the captain plays every round");
            }
            let field = g.alliances;
            let before: Vec<i32> = g.robots.iter().map(|r| r.battery).collect();
            g.lock(0, 10).unwrap();
            g.lock(1, 11).unwrap();
            assert_eq!(g.status, Status::Results);
            if round == 1 {
                for (side, on_field) in field.iter().enumerate() {
                    for inst in g.seat(side).pool.clone() {
                        let r = g.robot(inst).unwrap();
                        if on_field.contains(&inst) {
                            assert_eq!(r.battery, 100 - DRAIN, "fielding costs charge, broken or not");
                        } else {
                            assert_eq!(r.battery, 100, "the bench recharges, up to full");
                        }
                    }
                }
            }
            assert_eq!(before.len(), g.robots.len());
            g.ack(0, 12).unwrap();
            g.ack(1, 13).unwrap();
        }
        assert_eq!(g.status, Status::Final);
        let o = g.outcome.as_ref().unwrap();
        assert_eq!(o.rp, [g.seat(0).rp, g.seat(1).rp]);
        assert!(g.seat(0).rp >= 0 && g.rounds.len() == 5);
    }

    #[test]
    fn choosing_partners_and_broken_robots() {
        let (mut g, _, _) = drafted();
        let pool = g.seat(0).pool.clone();
        let out: Vec<u32> = pool.iter().copied().filter(|i| !g.alliances[0].contains(i)).collect();
        assert_eq!(g.set_partners(0, [out[0], out[0]]), Err("bad_partners"));
        assert_eq!(g.set_partners(0, [out[0], g.seat(1).pool[0]]), Err("not_in_pool"));
        // A part on a robot that leaves the field comes off with it.
        let part = *g.seat(0).hand.iter().find(|c| g.card(**c).unwrap().kind == Kind::Part).unwrap();
        let old = g.alliances[0][1];
        g.attach(0, part, old).unwrap();
        g.robots.iter_mut().find(|r| r.inst == out[1]).unwrap().broken = 1;
        assert_eq!(g.set_partners(0, [out[0], out[1]]), Err("broken"));
        g.set_partners(0, [out[0], out[2]]).unwrap();
        assert_eq!(g.alliances[0][1..], [out[0], out[2]]);
        assert_eq!(g.seat(0).plan.stations, [g.seat(0).captain, out[0], out[2]]);
        assert!(g.seat(0).plan.attach.is_empty(), "the part came off with the robot");
        g.lock(0, 5).unwrap();
        assert_eq!(g.set_partners(0, [out[0], out[2]]), Err("locked"));
    }

    #[test]
    fn a_broken_robot_sits_out_a_round_and_comes_back_repaired() {
        let (mut g, _, _) = drafted();
        let sick = *g.seat(0).pool.iter().find(|i| !g.alliances[0].contains(i)).unwrap();
        let r = g.robots.iter_mut().find(|r| r.inst == sick).unwrap();
        r.broken = 1;
        r.battery = 10;
        g.lock(0, 5).unwrap();
        g.lock(1, 5).unwrap();
        let r = g.robot(sick).unwrap();
        assert_eq!((r.broken, r.battery), (0, REPAIR_BATTERY), "a round on the bench repairs it");
    }

    #[test]
    fn tired_robots_swap_out_by_default() {
        let (mut g, _, _) = drafted();
        let [a, b] = g.seat(0).plan.partners;
        for i in [a, b] {
            g.robots.iter_mut().find(|r| r.inst == i).unwrap().battery = 20;
        }
        assert_ne!(g.default_partners(0), [a, b], "low-power partners are replaced when you don't choose");
        g.robots.iter_mut().find(|r| r.inst == a).unwrap().battery = 100;
        let d = g.default_partners(0);
        assert!(d.contains(&a), "a charged partner stays");
        assert!(!d.contains(&b));
    }

    #[test]
    fn three_cards_a_round_and_unplayed_ones_stay() {
        let (mut g, _, _) = drafted();
        assert_eq!(g.seat(0).hand.len(), 3);
        let part = *g.seat(0).hand.iter().find(|c| g.card(**c).unwrap().kind == Kind::Part).unwrap();
        let robot = g.alliances[0][1];
        g.attach(0, part, robot).unwrap();
        g.lock(0, 10).unwrap();
        g.lock(1, 10).unwrap();
        assert_eq!(g.seat(0).hand.len(), 2, "the attached part is used up");
        assert_eq!(g.seat(1).hand.len(), 3, "nothing played, nothing lost");
        g.ack(0, 11).unwrap();
        g.ack(1, 11).unwrap();
        assert_eq!(g.seat(0).hand.len(), 5);
        assert_eq!(g.seat(1).hand.len(), 6);
        assert!(!g.seat(0).hand.contains(&part), "a used part can't come back");
    }

    #[test]
    fn pit_rules_are_enforced() {
        let (mut g, _, _) = drafted();
        let theirs = g.seat(1).hand[0];
        let my_robot = g.alliances[0][0];
        assert_eq!(g.attach(0, theirs, my_robot), Err("not_in_hand"));
        let mine = *g.seat(0).hand.iter().find(|c| g.card(**c).unwrap().kind == Kind::Part).unwrap();
        assert_eq!(g.attach(0, mine, g.alliances[1][0]), Err("not_your_robot"));
        let a = g.alliances[0];
        assert_eq!(g.set_stations(0, [a[0], a[0], a[1]]), Err("bad_stations"));
        g.set_stations(0, [a[2], a[0], a[1]]).unwrap();
        g.lock(0, 5).unwrap();
        assert_eq!(g.set_stations(0, a), Err("locked"), "locked means frozen");
    }

    #[test]
    fn only_one_lore_and_only_lore() {
        let (mut g, _, _) = drafted();
        let hand = g.seat(0).hand.clone();
        let part = hand.iter().copied().find(|c| g.card(*c).unwrap().kind == Kind::Part).unwrap();
        assert_eq!(g.set_lore(0, Some(part)), Err("not_in_hand"));
        // The lore slot holds one card; picking another replaces it.
        g.set_lore(0, None).unwrap();
        assert_eq!(g.seat(0).plan.lore, None);
    }

    #[test]
    fn the_opponents_secrets_stay_hidden() {
        let (mut g, _, _) = drafted();
        let mine = g.seat(0).hand[0];
        if g.card(mine).unwrap().kind == Kind::Part {
            g.attach(0, mine, g.alliances[0][0]).unwrap();
        }
        let v = serde_json::to_value(g.view(Some(1))).unwrap();
        let me = &v["me"];
        assert_eq!(me["side"], 1);
        assert!(me["plan"]["attach"].as_array().unwrap().is_empty(), "bob sees his own plan, not alice's");
        let visible: Vec<u64> = v["support"].as_array().unwrap().iter().map(|c| c["inst"].as_u64().unwrap()).collect();
        assert!(!visible.contains(&u64::from(mine)), "alice's hand isn't visible to bob");
        assert!(v["seed"].is_null(), "the seed stays secret until the end");
        assert!(v.get("pool").is_none());
        // Alice's partners are hidden until the round is played; her captain and pool are public.
        assert_eq!(v["alliances"][0][1], 0);
        assert_eq!(v["alliances"][0][2], 0);
        assert_ne!(v["alliances"][0][0], 0);
        assert_ne!(v["alliances"][1][1], 0, "bob sees his own");
        let alice_partner = g.alliances[0][1];
        let shown: Vec<u64> = v["robots"].as_array().unwrap().iter().map(|r| r["inst"].as_u64().unwrap()).collect();
        assert!(shown.contains(&u64::from(alice_partner)), "pools are public, so her robots are known");
    }

    #[test]
    fn missing_the_pit_deadline_auto_locks_then_forfeits() {
        let (mut g, _, _) = drafted();
        g.lock(0, 10).unwrap();
        g.deadline = 1_000;
        assert!(g.tick(1_100));
        assert_eq!(g.status, Status::Results);
        assert!(g.rounds[0].auto_locked[1]);
        assert_eq!(g.seat(1).strikes, 1);
        assert!(g.tick(1_100 + RESULTS_MS));
        assert_eq!(g.status, Status::Pit);
        let t = 1_200 + RESULTS_MS;
        g.lock(0, t).unwrap();
        assert!(g.tick(t + 10 * PIT_MS));
        assert_eq!(g.status, Status::Final);
        let o = g.outcome.as_ref().unwrap();
        assert_eq!(o.winner, Some(0));
        assert_eq!(o.reason, "timeout");
    }

    #[test]
    fn placements_show_a_count_not_the_cards_and_emotes_are_limited() {
        let (mut g, _, _) = drafted();
        let part = *g.seat(0).hand.iter().find(|c| g.card(**c).unwrap().kind == Kind::Part).unwrap();
        let robot = g.alliances[0][2];
        g.attach(0, part, robot).unwrap();
        let v = serde_json::to_value(g.view(Some(1))).unwrap();
        assert_eq!(v["seats"][0]["parts_down"], 1, "bob sees that a card went down, nothing more");
        assert_eq!(v["seats"][0]["hand_count"], 2, "and alice's hand shrink");
        let shown: Vec<u64> = v["support"].as_array().unwrap().iter().map(|c| c["inst"].as_u64().unwrap()).collect();
        assert!(!shown.contains(&u64::from(part)), "but not which card");
        let rev = g.rev;
        g.emote(1, "gg", 100).unwrap();
        assert_eq!(g.emote(1, "nice", 900), Err("too_fast"));
        assert_eq!(g.emote(0, "lol", 900), Err("bad_emote"));
        g.emote(1, "nice", 2_200).unwrap();
        assert_eq!(g.rev, rev, "emotes don't change the game");
        assert_eq!(g.emote_seq, 2);
    }

    #[test]
    fn joining_rules() {
        let a = Uuid::new_v4();
        let mut g = Game::new("g".into(), Seat::new(a, "a".into(), 1000), 1, 0);
        assert_eq!(g.join(Seat::new(a, "a".into(), 1000), 1), Err("own_game"));
        g.join(Seat::new(Uuid::new_v4(), "b".into(), 1000), 1).unwrap();
        assert_eq!(g.join(Seat::new(Uuid::new_v4(), "c".into(), 1000), 2), Err("game_full"));
    }

    #[test]
    fn ratings_change_once_by_the_spec_formula() {
        let (mut g, _, _) = drafted();
        g.forfeit(1).unwrap();
        let after = g.rate([1000, 1000]);
        assert_eq!(after, [1016, 984]);
        assert_eq!(g.outcome.as_ref().unwrap().winner, Some(0));
        assert_eq!(g.forfeit(1), Err("cant_forfeit"), "a finished game can't end again");
    }

    #[test]
    fn same_seed_same_game() {
        let (mut a, _, _) = drafted();
        let (mut b, _, _) = drafted();
        assert_eq!(a.seat(0).pool, b.seat(0).pool);
        a.lock(0, 1).unwrap();
        a.lock(1, 1).unwrap();
        b.lock(0, 1).unwrap();
        b.lock(1, 1).unwrap();
        assert_eq!(a.rounds[0].result, b.rounds[0].result);
        assert_eq!(seed_hash(a.seed), a.seed_hash);
    }
}

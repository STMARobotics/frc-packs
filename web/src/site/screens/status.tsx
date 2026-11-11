// Under the packs: the free-pack timer, the Mythic meter, your streak and today's missions. Free packs waiting to be
// claimed get a big button above the pack instead (ClaimButton).
import { useEffect, useState } from "preact/hooks";
import { api, type Mission } from "../../api";
import { useStore } from "../../lib/store";
import { RECIPE } from "../data";
import { applyState, fail, packOf, skew, st, sync, toast } from "../state";
import { cx } from "../ui";
import { sfx } from "../sfx";

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`;
};

/** A countdown whose width never changes as it ticks: the title font's digits aren't all the same width, so each one
    gets a box of its own. */
function Clock({ text }: { text: string }) {
  return <span class="st-clock" aria-label={text}>{[...text].map((ch) => <i class={ch === ":" ? "st-colon" : undefined} aria-hidden="true">{ch}</i>)}</span>;
}

/** Ticks once a second; only the component using it redraws. */
export function useNow(ms = 1000) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), ms); return () => clearInterval(t); }, [ms]);
  return Date.now() + skew;
}

/** Packs waiting to be claimed (missed timers bank up to a limit). */
export function banked(now: number) {
  const s = st.get()!;
  return now < s.nextClaimAt ? 0 : Math.min(s.bank, 1 + Math.floor((now - s.nextClaimAt) / s.claimMs));
}

/** Free packs waiting: one big button, first thing on the Open tab. Nothing while the timer runs. */
export function ClaimButton() {
  const s = useStore(st)!;
  const now = useNow();
  const [claiming, setClaiming] = useState(false);
  const n = banked(now), ready = n * (s.claimPacks || 1);
  if (!n) return null;
  const claim = async () => {
    setClaiming(true);
    try { applyState(await api.claim()); sfx.claim(); } catch (e) { if ((e as { code?: string }).code === "not_ready") sync(); else fail(e); }
    setClaiming(false);
  };
  return <button type="button" class="s-btn wide st-claim" disabled={claiming} onClick={claim}>{ready === 1 ? "Claim your free pack" : `Claim ${ready} free packs`}</button>;
}

export function StatusBar() {
  const s = useStore(st)!;
  const now = useNow();
  const n = banked(now);
  const left = s.nextClaimAt + (n ? n * s.claimMs : 0) - now;
  const pity = packOf(s).pity.m, hard = RECIPE.odds.hard, soft = RECIPE.odds.soft;
  const [why, setWhy] = useState(false);
  return (
    <section class="s-status">
      <div class="st-timer">
        <small>Next pack</small><b>{n ? "Ready" : <Clock text={fmt(left)} />}</b>
      </div>
      <button type="button" class={cx("st-meter", pity >= soft && "hot")} aria-expanded={why} onClick={() => setWhy(!why)}>
        <small>Mythic meter <i class="st-info" aria-hidden="true">i</i></small>
        <span class="s-bar"><i style={{ transform: `scaleX(${Math.min(pity, hard) / hard})` }} /></span>
        <em>{pity}/{hard}</em>
      </button>
      {/* What the meter is (#115): packs since your last Mythic, not your collection. */}
      {why && <p class="st-why">Packs since your last Mythic. After {soft} the odds climb; by {hard} one is guaranteed.</p>}
      <Daily />
    </section>
  );
}

function Daily() {
  const s = useStore(st)!;
  // Open until you fold it away (then it stays folded on this device).
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("frcpacks.daily") !== "0"; } catch { return true; } });
  const [busy, setBusy] = useState("");
  const ms = s.missions ?? [], k = s.streak ?? { days: 0, today: false, alive: false, every: 7 };
  const done = ms.filter((m) => m.claimed).length, ready = ms.filter((m) => !m.claimed && m.progress >= m.goal).length;
  // Days into this week's streak. The day a boosted pack is earned starts a new week, so it shows 0 and the full
  // week to go (it showed 7 filled and "0 to go").
  const into = k.days % k.every;
  const toGift = k.every - into;
  const toggle = () => { setOpen(!open); try { localStorage.setItem("frcpacks.daily", open ? "0" : "1"); } catch { /* fine */ } };
  const collect = async (m: Mission) => {
    setBusy(m.id);
    try { applyState(await api.claimMission(m.id)); sfx.claim(); toast(`+${m.reward} parts`); } catch (e) { fail(e); }
    setBusy("");
  };
  return (
    <div class="st-daily">
      <button type="button" class="st-daily-h" aria-expanded={open} onClick={toggle}>
        <span class={cx("st-flame", k.today && k.days > 0 && "lit")}>🔥 {k.days}</span>
        <span class="st-daily-t"><b>{k.days ? `${k.days}-day streak` : "Start a streak"}</b><small>{ready ? `${ready} to collect · ` : ""}Daily missions {done}/{ms.length}</small></span>
        <span class="st-dots">{ms.map((m) => <i class={m.claimed ? "done" : m.progress >= m.goal ? "ready" : ""} />)}</span>
        <span class="st-chev" aria-hidden="true">›</span>
      </button>
      {open && (
        <div class="st-daily-b">
          {ms.map((m) => {
            const full = m.progress >= m.goal;
            return (
              <div class={cx("st-mission", m.claimed && "claimed", full && !m.claimed && "ready")}>
                <b>{m.label}</b>
                <span class="s-bar"><i style={{ transform: `scaleX(${Math.min(1, m.progress / m.goal)})` }} /></span>
                {m.claimed ? <span class="s-dim">✓ +{m.reward}</span>
                  : full ? <button type="button" class="s-btn small" disabled={busy === m.id} onClick={() => collect(m)}>Collect +{m.reward}</button>
                  : <span class="s-dim">{m.progress}/{m.goal} · +{m.reward}</span>}
              </div>
            );
          })}
          <p class="s-dim st-note">
            <span class="st-week">{Array.from({ length: k.every }, (_, i) => <i class={i + 1 <= into ? "on" : i + 1 === k.every ? "gift" : ""} />)}</span>
            {k.days ? `${toGift} to a boosted pack` : `Open ${k.every} days in a row for a boosted pack`}
          </p>
        </div>
      )}
    </div>
  );
}

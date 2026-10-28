// Above the packs: the free-pack timer (or Claim), the Mythic meter, your streak and today's missions.
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

export function StatusBar() {
  const s = useStore(st)!;
  const now = useNow();
  const [claiming, setClaiming] = useState(false);
  const n = banked(now), ready = n * (s.claimPacks || 1);
  const left = s.nextClaimAt + (n ? n * s.claimMs : 0) - now;
  const pity = packOf(s).pity.m, hard = RECIPE.odds.hard, soft = RECIPE.odds.soft;
  const claim = async () => {
    setClaiming(true);
    try { applyState(await api.claim()); sfx.claim(); } catch (e) { if ((e as { code?: string }).code === "not_ready") sync(); else fail(e); }
    setClaiming(false);
  };
  return (
    <section class="s-status">
      <div class="st-timer">
        {n ? <button type="button" class="s-btn small" disabled={claiming} onClick={claim}>{ready === 1 ? "Claim pack" : `Claim ${ready} packs`}</button>
          : <><small>Next pack</small><b>{fmt(left)}</b></>}
      </div>
      <div class={cx("st-meter", pity >= soft && "hot")} title={`Packs since your last Mythic. Odds climb after ${soft}; one is guaranteed by pack ${hard}.`}>
        <small>Mythic meter</small>
        <span class="s-bar"><i style={{ transform: `scaleX(${Math.min(pity, hard) / hard})` }} /></span>
        <em>{pity}/{hard}</em>
      </div>
      <Daily />
    </section>
  );
}

function Daily() {
  const s = useStore(st)!;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("frcpacks.daily") === "1"; } catch { return false; } });
  const [busy, setBusy] = useState("");
  const ms = s.missions ?? [], k = s.streak ?? { days: 0, today: false, alive: false, every: 7 };
  const done = ms.filter((m) => m.claimed).length, ready = ms.filter((m) => !m.claimed && m.progress >= m.goal).length;
  const into = k.days % k.every || (k.days ? k.every : 0);
  const toGift = k.every - (k.days % k.every || (k.today ? k.every : 0));
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
        <span class="st-daily-t"><b>{k.days ? `${k.days}-day streak` : "Start a streak"}</b><small>{ready ? `${ready} to collect · ` : ""}{done}/{ms.length} missions</small></span>
        <span class="st-dots">{ms.map((m) => <i class={m.claimed ? "done" : m.progress >= m.goal ? "ready" : ""} />)}</span>
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
            {k.today ? "Opened today. " : k.days ? "Open a pack today to keep it. " : ""}A boosted pack every {k.every} days in a row{k.days ? ` · ${toGift} to go` : ""}.
          </p>
        </div>
      )}
    </div>
  );
}

// Before the first draft pick: versus, both Alliance Captains, the decks shuffling together, and who picks first. Plays
// once per game over the draft screen; tap anywhere to skip. The first pick has extra time on the server's clock for it.
import { useEffect, useRef, useState } from "preact/hooks";
import { preload } from "../store";
import { sfx } from "../sfx";
import type { GameView } from "../types";
import { Card, CardBack, cx } from "../ui";
import { robotOf } from "./state";
import { initial } from "./final";

type Stage = "vs" | "caps" | "flip" | "shuffle" | "coin" | "out";
const played = new Set<string>();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function Intro({ g }: { g: GameView }) {
  const [stage, setStage] = useState<Stage | null>(() =>
    played.has(g.id) || g.draft_turn !== 0 || matchMedia("(prefers-reduced-motion: reduce)").matches ? null : "vs");
  const side = g.me!.side, op = 1 - side;
  const myCap = robotOf(g, g.alliances[side][0]), theirCap = robotOf(g, g.alliances[op][0]);
  const skipped = useRef(false);

  useEffect(() => {
    if (!stage || !myCap || !theirCap) { setStage(null); return; }
    played.add(g.id);
    let alive = true;
    const at = async (ms: number, s: Stage | null, fx?: () => void) => { await wait(ms); if (!alive || skipped.current) return false; setStage(s); fx?.(); return true; };
    (async () => {
      preload([myCap.team, theirCap.team]);
      sfx.flip();
      if (!(await at(1500, "caps", sfx.pick))) return;
      if (!(await at(600, "flip", sfx.flip))) return;
      if (!(await at(2000, "shuffle"))) return;
      for (let i = 0; i < 5; i++) { sfx.dice(); await wait(170); }
      if (!(await at(500, "coin", sfx.boom))) return;
      if (!(await at(1800, "out"))) return;
      await at(300, null);
    })();
    return () => { alive = false; };
  }, []);

  if (!stage || !myCap || !theirCap) return null;
  const me = g.seats[side]!, them = g.seats[op]!;
  const first = g.draft_side === side;
  const skip = () => { skipped.current = true; setStage("out"); setTimeout(() => setStage(null), 250); };
  const cap = (r: typeof myCap, label: string, mine: boolean) => (
    <div class={cx("in-cap", mine ? "mine" : "theirs")}>
      <div class={cx("in-flip", stage !== "caps" && "up")}><div class="in-f"><Card r={r} w="var(--iw)" /></div><div class="in-b"><CardBack /></div></div>
      <small>{label}</small>
    </div>
  );
  return (
    <div class={cx("b-intro", stage === "out" && "out")} onClick={skip}>
      <button class="in-skip" type="button">Skip</button>
      {stage === "vs" && (
        <div class="in-stage in-vs">
          <div class="in-p me"><span class="b-ava me">{initial(me.name)}</span><b>{me.name}</b><small>{me.elo} Elo</small></div>
          <i>VS</i>
          <div class="in-p op"><span class="b-ava op">{initial(them.name)}</span><b>{them.name}</b><small>{them.elo} Elo</small></div>
        </div>
      )}
      {(stage === "caps" || stage === "flip") && (
        <div class="in-stage"><h3>Alliance Captains</h3><div class="in-capsrow">{cap(myCap, "Yours", true)}{cap(theirCap, them.name, false)}</div></div>
      )}
      {stage === "shuffle" && (
        <div class="in-stage">
          <div class="in-decks"><div class="in-deck">{[0, 1, 2, 3, 4, 5].map((i) => <i style={{ "--i": i }} />)}</div><div class="in-deck">{[0, 1, 2, 3, 4, 5].map((i) => <i style={{ "--i": i }} />)}</div></div>
          <h3>Shuffling both decks</h3>
        </div>
      )}
      {(stage === "coin" || stage === "out") && (
        <div class="in-stage"><div class="in-coin"><b>{first ? initial(me.name) : initial(them.name)}</b></div><h3>{first ? "You pick first" : `${them.name} picks first`}</h3></div>
      )}
    </div>
  );
}

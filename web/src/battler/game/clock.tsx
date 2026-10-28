// The countdown for the current step (draft pick, pit, results), as text or as a ring around a player's picture. Each
// one redraws only itself, four times a second.
import { useEffect, useState } from "preact/hooks";
import { CAT } from "../store";
import type { GameView } from "../types";
import { cx } from "../ui";
import { clockSkew } from "./state";

function useLeft(g: GameView) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(t); }, []);
  return g.deadline ? Math.max(0, g.deadline - (Date.now() + clockSkew)) : 0;
}

export function Clock({ g }: { g: GameView }) {
  const left = useLeft(g);
  if (!g.deadline) return null;
  const s = Math.round(left / 1000);
  return <span class={cx("b-clock", s <= 15 && "low")}>{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}</span>;
}

export function Ring({ g }: { g: GameView }) {
  const left = useLeft(g);
  if (!g.deadline) return null;
  const full = (g.status === "PIT" ? CAT.rules.pit_seconds : g.status === "DRAFT" ? CAT.rules.draft_seconds : CAT.rules.results_seconds) * 1000;
  const k = Math.min(1, left / full);
  return (
    <svg class={cx("b-ring", left < 15000 && "low")} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="18" />
      <circle class="run" cx="20" cy="20" r="18" style={{ strokeDashoffset: 113 * (1 - k) }} />
    </svg>
  );
}

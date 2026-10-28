import { useEffect, useState } from "preact/hooks";
import { call, explain } from "../api";
import type { HistoryRow } from "../types";
import { cx, Empty, Head, Spinner } from "../ui";

export function ago(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
}

export function History() {
  const [rows, setRows] = useState<HistoryRow[] | string | null>(null);
  useEffect(() => { call<{ games: HistoryRow[] }>("GET", "/api/battler/history").then((r) => setRows(r.games), (e) => setRows(explain(e))); }, []);
  return (
    <div class="b-screen">
      <Head title="History" />
      {rows === null ? <div class="b-center"><Spinner /></div>
        : typeof rows === "string" ? <Empty>{rows}</Empty>
        : !rows.length ? <Empty>No games yet.</Empty>
        : (
          <div class="b-list">
            {rows.map((h) => {
              const d = h.elo_after - h.elo_before;
              const res = h.winner === true ? "win" : h.winner === false ? "loss" : "draw";
              return (
                <div key={h.game} class={cx("b-row", res)}>
                  <div><b>{res === "win" ? "Won" : res === "loss" ? "Lost" : "Draw"} vs {h.opponent}</b>
                    <span>{h.rp[0]}–{h.rp[1]} RP · {h.points[0]}–{h.points[1]} pts{h.reason !== "complete" ? ` · ${h.reason}` : ""} · {ago(h.at)}</span></div>
                  <span class={cx("b-delta", d >= 0 ? "up" : "down")}>{d >= 0 ? "+" : ""}{d}</span>
                </div>
              );
            })}
          </div>
        )}
    </div>
  );
}

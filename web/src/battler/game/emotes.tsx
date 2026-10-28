// Quick chat: a few canned lines, shown as a bubble by the player who sent them.
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, call, explain } from "../api";
import { closeSheet, openSheet, pref, setPref, store, toast, useStore } from "../store";
import { sfx } from "../sfx";
import type { GameView } from "../types";
import { cx } from "../ui";

export const EMOTE_TEXT: Record<string, string> = { gg: "GG!", nice: "Nice play!", oops: "Oops…", wow: "Wow!", thinking: "Hmm…", hello: "Hello!" };

const bubbles = store<{ id: number; who: "me" | "op"; text: string }[]>([]);
let bubbleN = 0;
function pop(who: "me" | "op", text: string) {
  const id = ++bubbleN;
  bubbles.set([...bubbles.get().filter((b) => b.who !== who), { id, who, text }]);
  setTimeout(() => bubbles.set(bubbles.get().filter((b) => b.id !== id)), 2600);
}

export function Emotes({ g }: { g: GameView }) {
  const list = useStore(bubbles);
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (!g.me) return;
    if (seen.current === null) { seen.current = g.emote_seq; return; }
    for (const e of g.emotes) {
      if (e.n <= seen.current) continue;
      seen.current = e.n;
      if (e.side === g.me.side || pref("bt-mute-emotes")) continue;
      sfx.emote();
      pop("op", EMOTE_TEXT[e.id] ?? e.id);
    }
  }, [g.emote_seq]);
  return <>{list.map((b) => <div key={b.id} class={cx("b-bubble", b.who)}>{b.text}</div>)}</>;
}

export function openEmotes(g: GameView) {
  openSheet(() => <EmoteSheet g={g} />);
}

function EmoteSheet({ g }: { g: GameView }) {
  const [muted, setMuted] = useState(pref("bt-mute-emotes"));
  const send = async (id: string) => {
    closeSheet();
    pop("me", EMOTE_TEXT[id]);
    try { await call("POST", `/api/battler/games/${g.id}/emote`, { emote: id }); } catch (e) { if (!(e instanceof ApiError && e.code === "too_fast")) toast(explain(e), true); }
  };
  return (
    <div class="b-emotesheet">
      <h2>Quick chat</h2>
      <div class="b-emotes">{Object.entries(EMOTE_TEXT).map(([id, t]) => <button type="button" class="b-btn ghost" onClick={() => send(id)}>{t}</button>)}</div>
      <label class="b-check"><input type="checkbox" checked={muted} onChange={(e) => { setMuted(e.currentTarget.checked); setPref("bt-mute-emotes", e.currentTarget.checked); }} /> Hide their chat</label>
    </div>
  );
}

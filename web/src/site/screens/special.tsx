// Special editions: numbered, limited-run cards the admin hands out (never from packs). Their own art: a holo frame,
// the team number, the photo, and the copy's number out of the run. Up close you hold it to turn it, like a card.
import { useRef } from "preact/hooks";
import type { Special } from "../../api";
import { back, cx, push, useGrabTilt } from "../ui";

const pad3 = (n: number) => String(n).padStart(3, "0");

/** The card. `w` is its width (any CSS length); everything inside scales with it. */
export function SpecialCard({ sp, w }: { sp: Special; w: string }) {
  return (
    <div class="se-tilt" style={{ "--sw": w }}>
      <div class="se" aria-label={`${sp.name}, team ${sp.team}, ${sp.title}, number ${sp.serial} of ${sp.total}`}>
        <div class="se-in">
          <div class="se-hd">
            <span class="se-num"><small>TEAM</small>{sp.team}</span>
            <span class="se-run">LIMITED<b>{pad3(sp.serial)} / {sp.total}</b></span>
          </div>
          <div class="se-photo"><img src={`/photos/${sp.team}.webp`} alt="" draggable={false} decoding="async" /></div>
          <div class="se-bot">
            <span class="se-nm">{sp.name}<small>{sp.title}</small></span>
            <span class="se-sn">No.<b>{pad3(sp.serial)}</b></span>
          </div>
          <span class="se-sheen" />
          {[0, 1, 2, 3, 4, 5].map((i) => <i class="se-star" style={{ "--i": i }} />)}
        </div>
        <i class="se-glare" />
      </div>
    </div>
  );
}

/** A row of special editions; tap one to see it up close. */
export function SpecialRow({ list, cls }: { list: Special[]; cls?: string }) {
  if (!list.length) return null;
  return (
    <div class={cx("se-row", cls)}>
      {list.map((sp) => (
        <button type="button" class="se-thumb" onClick={() => openSpecial(sp)} aria-label={`${sp.title}, No. ${sp.serial} of ${sp.total}`}>
          <SpecialCard sp={sp} w="100%" />
        </button>
      ))}
    </div>
  );
}

export function openSpecial(sp: Special) {
  push(() => <SpecialView sp={sp} />, "card");
}

function SpecialView({ sp }: { sp: Special }) {
  const el = useRef<HTMLDivElement>(null);
  useGrabTilt(el, ".se-tilt", ".se");
  return (
    <div class="se-view">
      <header class="s-head"><button type="button" class="s-icon" onClick={back} aria-label="Close">×</button></header>
      <div ref={el} class="se-hold"><SpecialCard sp={sp} w="min(78vw, 340px, calc((100svh - 260px) / 1.4))" /></div>
      <p class="se-note"><b>{sp.title}</b>Copy {sp.serial} of {sp.total}. Only {sp.total} will ever exist.</p>
    </div>
  );
}

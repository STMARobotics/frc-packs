// The pack's top strip as one soft wrapper, drawn on a canvas in the pack's front face. The strip is a chain of points
// along its seam; the part behind the tear curls up from the tear point and the points spring toward that curl, so the
// wrapper bends, lags a little and wobbles as you pull, then settles (or lies back down when you let go). The light of
// the best card comes only out of the gap that's been torn open. Nothing runs once it has settled.

const N = 40; // points along the seam
const CURL = 0.045; // how fast the torn part curls up, per point behind the tear (radians)
const MAX_CURL = 0.8;
const STRIP = 0.14; // strip height, as a share of the pack's height
const EDGE = 0.12; // where the pack's body starts under the strip
// The canvas reaches past the pack so the lifted strip has room: 15% each side, 30% above.
const PAD_X = 0.15, PAD_Y = 0.3, CANVAS_H = 0.44;

export interface Rip {
  /** `tear` is how far the tear has come from the side it started on (share of the width), `dir` 1 from the left or
      -1 from the right, `light` how bright the gap is (0 to 1), `color` the best card's color. */
  set(tear: number, dir: number, light: number, color: string): void;
  /** A jolt as the tear catches. */
  jolt(t: number): void;
  stop(): void;
}

export function createRip(cv: HTMLCanvasElement, pack: HTMLElement, reduced: boolean): Rip {
  const PW = pack.offsetWidth, PH = pack.offsetHeight, dpr = Math.min(devicePixelRatio || 1, 2);
  const W = PW * (1 + PAD_X * 2), H = PH * CANVAS_H, ox = PW * PAD_X, oy = PH * PAD_Y, SH = PH * STRIP, seg = PW / N;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext("2d")!;
  const css = getComputedStyle(pack), v = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
  const tex = texture(PW, SH, dpr, v("--pa", "#8fe9ff"), v("--pb", "#3c6cf0"), v("--pc", "#141a46"), PH);

  const rest = (i: number) => [ox + i * seg, oy + SH] as const;
  const px = new Float32Array(N + 1), py = new Float32Array(N + 1), vx = new Float32Array(N + 1), vy = new Float32Array(N + 1);
  const tx = new Float32Array(N + 1), ty = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) { [px[i], py[i]] = rest(i); tx[i] = px[i]; ty[i] = py[i]; }
  let tear = 0, dir = 1, light = 0, color = "#fff", raf = 0, last = 0, stopped = false;

  /** Where each point wants to be: flat ahead of the tear, curling up behind it. */
  const targets = () => {
    const hinge = Math.min(N, tear * N);
    for (let i = 0; i <= N; i++) { [tx[i], ty[i]] = rest(i); }
    if (hinge <= 0) return;
    // Walk back from the tear point toward the side it started on, turning a little more with each step.
    let x = ox + (dir > 0 ? hinge : N - hinge) * seg, y = oy + SH, dPrev = 0;
    for (let k = Math.floor(hinge); k >= 0; k--) {
      const i = dir > 0 ? k : N - k, d = hinge - k, a = Math.min(MAX_CURL, (CURL * (d + dPrev)) / 2), step = (d - dPrev) * seg;
      x -= dir * Math.cos(a) * step; y -= Math.sin(a) * step;
      tx[i] = x; ty[i] = y; dPrev = d;
    }
  };

  const draw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const hingeX = ox + (dir > 0 ? tear : 1 - tear) * PW, x0 = dir > 0 ? ox : hingeX, x1 = dir > 0 ? hingeX : ox + PW;
    // The light inside the pack, only where it's open: a glow rising out of the gap and a bright line along the edge.
    if (light > 0.01 && x1 - x0 > 1) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const top = oy + PH * EDGE, g = ctx.createLinearGradient(0, top, 0, top - PH * 0.3);
      g.addColorStop(0, rgba(color, 0.9 * light)); g.addColorStop(0.35, rgba(color, 0.35 * light)); g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x0, top - PH * 0.3, x1 - x0, PH * 0.3 + 2);
      // Rays fanning up out of the gap.
      const rays = Math.max(1, Math.round((x1 - x0) / 26));
      for (let r = 0; r < rays; r++) {
        const cx = x0 + ((r + 0.5) / rays) * (x1 - x0), spread = 10 + (r % 3) * 6, lean = (r - (rays - 1) / 2) * 6, rg = ctx.createLinearGradient(0, top, 0, top - PH * 0.42);
        rg.addColorStop(0, rgba(color, 0.32 * light)); rg.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = rg;
        ctx.beginPath(); ctx.moveTo(cx - 3, top); ctx.lineTo(cx + 3, top); ctx.lineTo(cx + lean + spread, top - PH * 0.42); ctx.lineTo(cx + lean - spread, top - PH * 0.42); ctx.closePath(); ctx.fill();
      }
      ctx.restore();
      // A bright, ragged edge of torn foil along the opening.
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.strokeStyle = rgba(color, Math.min(1, 0.4 + light)); ctx.lineWidth = 2; ctx.shadowColor = color; ctx.shadowBlur = 10 * light;
      ctx.beginPath();
      for (let x = x0, n = 0; x <= x1; x += 4, n++) { const y = top + (n % 2 ? 1.5 : -1); if (x === x0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
      ctx.restore();
    }
    // The strip, one thin slice per pair of points, each turned to follow its part of the wrapper.
    for (let i = 0; i < N; i++) {
      const a = Math.atan2(py[i + 1] - py[i], px[i + 1] - px[i]), len = Math.hypot(px[i + 1] - px[i], py[i + 1] - py[i]);
      ctx.setTransform(dpr * Math.cos(a), dpr * Math.sin(a), -dpr * Math.sin(a), dpr * Math.cos(a), px[i] * dpr, py[i] * dpr);
      ctx.drawImage(tex, (i / N) * tex.width, 0, tex.width / N, tex.height, 0, -SH, len + 0.75, SH);
    }
  };

  const step = (now: number) => {
    raf = 0;
    if (stopped) return;
    const dt = Math.min(2, last ? (now - last) / 16.7 : 1);
    last = now;
    let moving = 0;
    for (let i = 0; i <= N; i++) {
      if (reduced) { px[i] = tx[i]; py[i] = ty[i]; continue; }
      vx[i] = (vx[i] + (tx[i] - px[i]) * 0.2 * dt) * Math.pow(0.8, dt);
      vy[i] = (vy[i] + (ty[i] - py[i]) * 0.2 * dt) * Math.pow(0.8, dt);
      px[i] += vx[i] * dt; py[i] += vy[i] * dt;
      moving = Math.max(moving, Math.abs(vx[i]) + Math.abs(vy[i]) + Math.abs(tx[i] - px[i]) + Math.abs(ty[i] - py[i]));
    }
    draw();
    if (moving > 0.05) raf = requestAnimationFrame(step); else last = 0;
  };
  const wake = () => { if (!raf && !stopped) raf = requestAnimationFrame(step); };
  draw();

  return {
    set(t, d, l, c) { tear = Math.max(0, Math.min(1, t)); dir = d || 1; light = l; color = c; targets(); wake(); },
    jolt(t) {
      if (reduced) return;
      // One smooth ripple through the loose part, strongest a little behind the tear, so the wrapper flaps as a whole.
      const hinge = tear * N, kick = (1 + t * 3) * (0.6 + Math.random() * 0.4);
      for (let k = Math.max(0, Math.floor(hinge) - 12); k <= Math.min(N, hinge); k++) {
        const i = dir > 0 ? k : N - k, w = Math.sin((Math.PI * (hinge - k)) / 12);
        vy[i] -= kick * Math.max(0, w);
      }
      wake();
    },
    stop() { stopped = true; cancelAnimationFrame(raf); },
  };
}

/** The strip's look, drawn once: the pack's foil gradient and fine stripes, the perforation, and the jagged seam. */
function texture(w: number, h: number, dpr: number, a: string, b: string, c: string, packH: number) {
  const t = document.createElement("canvas");
  t.width = Math.round(w * dpr); t.height = Math.round(h * dpr);
  const x = t.getContext("2d")!;
  x.scale(dpr, dpr);
  // The seam: teeth along the bottom, rounded corners on top.
  const r = w * 0.03;
  x.beginPath();
  x.moveTo(0, r); x.quadraticCurveTo(0, 0, r, 0); x.lineTo(w - r, 0); x.quadraticCurveTo(w, 0, w, r);
  for (let i = 25; i >= 0; i--) x.lineTo((i / 25) * w, h * (i % 2 ? 1 : 0.8));
  x.closePath();
  x.clip();
  const g = x.createLinearGradient(0, 0, w * 0.35, packH); // the same 165° sweep as the pack, of which this is the top
  g.addColorStop(0, a); g.addColorStop(0.48, b); g.addColorStop(1, c);
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  x.fillStyle = "rgba(255,255,255,.06)";
  for (let i = 0; i < w; i += 9) x.fillRect(i, 0, 2, h);
  const side = x.createLinearGradient(0, 0, w, 0);
  side.addColorStop(0, "rgba(0,0,0,.4)"); side.addColorStop(0.13, "rgba(0,0,0,0)"); side.addColorStop(0.87, "rgba(0,0,0,0)"); side.addColorStop(1, "rgba(0,0,0,.4)");
  x.fillStyle = side; x.fillRect(0, 0, w, h);
  x.fillStyle = "rgba(255,255,255,.55)";
  for (let i = 0; i < w; i += 11) x.fillRect(i, h * 0.4, 6, 2);
  return t;
}

function rgba(hex: string, a: number) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a.toFixed(3)})` : hex;
}

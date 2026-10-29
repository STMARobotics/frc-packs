// The pack's top strip as one soft wrapper, drawn on a canvas in the pack's front face. The strip is a chain of points
// along its seam. Behind the tear, the torn part folds toward you around the seam (it tips out of the screen, so it
// foreshortens and darkens) and bends up a little, more the further it is from your finger; the points spring toward
// that shape, so the wrapper is stiff but gives and flaps a little as you pull, then settles (or lies back down when
// you let go). The best card's light comes only out of the gap that's been torn open. Nothing runs once settled.

const N = 40; // points along the seam
const FOLD = 0.11; // how fast the torn part folds toward you, per point behind the tear (radians)
const MAX_FOLD = 1.2;
const CURL = 0.018; // and how fast it bends up in the screen's plane
const MAX_CURL = 0.3;
const STRIP = 0.13; // strip height, as a share of the pack's height (the seam is at its bottom)
// The canvas reaches past the pack so the lifted strip has room: 15% each side, 30% above.
const PAD_X = 0.15, PAD_Y = 0.3, CANVAS_H = PAD_Y + STRIP;
const K = 0.3, DAMP = 0.72; // spring stiffness and damping per frame

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
  const W = PW * (1 + PAD_X * 2), H = PH * CANVAS_H, ox = PW * PAD_X, oy = PH * PAD_Y, SH = PH * STRIP, seg = PW / N, seam = oy + SH;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(pack), v = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
  // The pack's foil sweep (the same 165° gradient as the pack, of which the strip is the top), and its darker sides.
  const foil = ctx.createLinearGradient(ox, oy, ox + PW * 0.35, oy + PH);
  foil.addColorStop(0, v("--pa", "#8fe9ff")); foil.addColorStop(0.48, v("--pb", "#3c6cf0")); foil.addColorStop(1, v("--pc", "#141a46"));
  const sides = ctx.createLinearGradient(ox, 0, ox + PW, 0);
  sides.addColorStop(0, "rgba(0,0,0,.4)"); sides.addColorStop(0.13, "rgba(0,0,0,0)"); sides.addColorStop(0.87, "rgba(0,0,0,0)"); sides.addColorStop(1, "rgba(0,0,0,.4)");
  const topX = new Float32Array(N + 1), topY = new Float32Array(N + 1);

  // Per point: position in the screen's plane, and how far the strip there has folded toward you; each with a speed.
  const px = new Float32Array(N + 1), py = new Float32Array(N + 1), pf = new Float32Array(N + 1);
  const vx = new Float32Array(N + 1), vy = new Float32Array(N + 1), vf = new Float32Array(N + 1);
  const tx = new Float32Array(N + 1), ty = new Float32Array(N + 1), tf = new Float32Array(N + 1);
  for (let i = 0; i <= N; i++) { px[i] = tx[i] = ox + i * seg; py[i] = ty[i] = seam; }
  let tear = 0, dir = 1, light = 0, color = "#fff", raf = 0, last = 0, stopped = false;

  /** Where each point wants to be: flat ahead of the tear, folding toward you (and bending up a little) behind it. */
  const targets = () => {
    const hinge = Math.min(N, tear * N);
    for (let i = 0; i <= N; i++) { tx[i] = ox + i * seg; ty[i] = seam; tf[i] = 0; }
    if (hinge <= 0) return;
    let x = ox + (dir > 0 ? hinge : N - hinge) * seg, y = seam, dPrev = 0;
    for (let k = Math.floor(hinge); k >= 0; k--) {
      const i = dir > 0 ? k : N - k, d = hinge - k, a = Math.min(MAX_CURL, (CURL * (d + dPrev)) / 2), step = (d - dPrev) * seg;
      x -= dir * Math.cos(a) * step; y -= Math.sin(a) * step;
      tx[i] = x; ty[i] = y; tf[i] = Math.min(MAX_FOLD, FOLD * d); dPrev = d;
    }
  };

  const draw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const hingeX = ox + (dir > 0 ? tear : 1 - tear) * PW, x0 = dir > 0 ? ox : hingeX, x1 = dir > 0 ? hingeX : ox + PW;
    // The light inside the pack, only where it's open: a glow rising out of the gap, rays, and a bright torn edge.
    if (light > 0.01 && x1 - x0 > 1) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const g = ctx.createLinearGradient(0, seam, 0, seam - PH * 0.3);
      g.addColorStop(0, rgba(color, 0.9 * light)); g.addColorStop(0.35, rgba(color, 0.35 * light)); g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g;
      ctx.fillRect(x0, seam - PH * 0.3, x1 - x0, PH * 0.3 + 2);
      const rays = Math.max(1, Math.round((x1 - x0) / 26));
      for (let r = 0; r < rays; r++) {
        const cx = x0 + ((r + 0.5) / rays) * (x1 - x0), spread = 10 + (r % 3) * 6, lean = (r - (rays - 1) / 2) * 6, rg = ctx.createLinearGradient(0, seam, 0, seam - PH * 0.42);
        rg.addColorStop(0, rgba(color, 0.32 * light)); rg.addColorStop(1, rgba(color, 0));
        ctx.fillStyle = rg;
        ctx.beginPath(); ctx.moveTo(cx - 3, seam); ctx.lineTo(cx + 3, seam); ctx.lineTo(cx + lean + spread, seam - PH * 0.42); ctx.lineTo(cx + lean - spread, seam - PH * 0.42); ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = rgba(color, Math.min(1, 0.4 + light)); ctx.lineWidth = 2; ctx.shadowColor = color; ctx.shadowBlur = 10 * light;
      ctx.beginPath();
      for (let x = x0, n = 0; x <= x1; x += 4, n++) { const y = seam + (n % 2 ? 1 : -0.6); if (x === x0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
      ctx.restore();
    }
    // The strip, as one band along the seam: each point's top edge stands up from the seam, shorter where the strip is
    // folded toward you (it's tipping out of the screen) and a little longer for being closer, so the edge stays smooth.
    for (let i = 0; i <= N; i++) {
      const a = i < N ? Math.atan2(py[i + 1] - py[i], px[i + 1] - px[i]) : Math.atan2(py[i] - py[i - 1], px[i] - px[i - 1]);
      const h = SH * Math.max(0.04, Math.cos(pf[i])) * (1 + Math.sin(pf[i]) * 0.16);
      topX[i] = px[i] + Math.sin(a) * h; topY[i] = py[i] - Math.cos(a) * h;
    }
    // One shape for the whole band (no seams between slices): the foil, its darker sides, and the shadow of the folded
    // part as a gradient along it, darker where it has turned further from the light.
    ctx.beginPath(); ctx.moveTo(px[0], py[0]);
    for (let i = 1; i <= N; i++) ctx.lineTo(px[i], py[i]);
    for (let i = N; i >= 0; i--) ctx.lineTo(topX[i], topY[i]);
    ctx.closePath();
    ctx.fillStyle = foil; ctx.fill();
    ctx.fillStyle = sides; ctx.fill();
    if (tear > 0) {
      const shadow = ctx.createLinearGradient(px[0], 0, px[N], 0), span = px[N] - px[0] || 1;
      for (let i = 0; i <= N; i++) shadow.addColorStop(Math.max(0, Math.min(1, (px[i] - px[0]) / span)), `rgba(5,8,20,${Math.min(0.7, Math.sin(Math.max(0, pf[i])) * 0.6).toFixed(3)})`);
      ctx.fillStyle = shadow; ctx.fill();
    }
    // The seal along the seam.
    ctx.beginPath(); ctx.moveTo(px[0], py[0] - 1.5);
    for (let i = 1; i <= N; i++) ctx.lineTo(px[i], py[i] - 1.5);
    ctx.strokeStyle = "rgba(255,255,255,.5)"; ctx.lineWidth = 1.5; ctx.stroke();
  };

  const step = (now: number) => {
    raf = 0;
    if (stopped) return;
    const dt = Math.min(2, last ? (now - last) / 16.7 : 1), damp = Math.pow(DAMP, dt);
    last = now;
    let moving = 0;
    for (let i = 0; i <= N; i++) {
      if (reduced) { px[i] = tx[i]; py[i] = ty[i]; pf[i] = tf[i]; continue; }
      vx[i] = (vx[i] + (tx[i] - px[i]) * K * dt) * damp;
      vy[i] = (vy[i] + (ty[i] - py[i]) * K * dt) * damp;
      vf[i] = (vf[i] + (tf[i] - pf[i]) * K * dt) * damp;
      px[i] += vx[i] * dt; py[i] += vy[i] * dt; pf[i] += vf[i] * dt;
      moving = Math.max(moving, Math.abs(vx[i]) + Math.abs(vy[i]) + Math.abs(tx[i] - px[i]) + Math.abs(ty[i] - py[i]) + (Math.abs(vf[i]) + Math.abs(tf[i] - pf[i])) * 40);
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
      // One small ripple through the loose part, strongest a little behind the tear: it gives, then springs back.
      const hinge = tear * N, kick = (0.5 + t * 1.2) * (0.6 + Math.random() * 0.4);
      for (let k = Math.max(0, Math.floor(hinge) - 12); k <= Math.min(N, hinge); k++) {
        const i = dir > 0 ? k : N - k, w = Math.max(0, Math.sin((Math.PI * (hinge - k)) / 12));
        vy[i] -= kick * w; vf[i] += 0.04 * kick * w;
      }
      wake();
    },
    stop() { stopped = true; cancelAnimationFrame(raf); },
  };
}

function rgba(hex: string, a: number) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a.toFixed(3)})` : hex;
}

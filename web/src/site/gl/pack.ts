// The pack in your hand, drawn with WebGL (Three.js) on a canvas over the opening. The DOM pack stays where it is,
// invisible, and still takes every touch; this draws the pack on top of it, following it wherever it goes (the drop
// into your hand, the jolts, the shakes). In 3D: the strip peels toward you along the seam with the same soft wrapper
// as the canvas version (rip.ts), the best card's light comes out of the gap only where it's open, and when it opens
// the strip flies off the way it was torn and the pack drops away, in front of the cards rising out of it. Then a
// burst of light on each card that turns over.
//
// Only loaded when a pack is opened (open.tsx imports it on demand), and only used where WebGL works and motion isn't
// reduced. It draws only while something moves: nothing runs while the pack sits in your hand.
import {
  BufferAttribute, BufferGeometry, CanvasTexture, CustomBlending, DoubleSide, Group, LinearFilter, Mesh, OneFactor, PerspectiveCamera,
  PlaneGeometry, Points, Scene, ShaderMaterial, type Texture, TextureLoader, WebGLRenderer,
} from "three";
import { wrapper } from "../rip";

export type Kind = "std" | "gold" | "myth" | "test";

/** The strip's height as a share of the pack's (the seam is at its bottom). The same as the CSS pack. */
const SEAM = 0.13;
/** Each face is this far in front of (or behind) the middle, as a share of the pack's width (--pth: 2.6cqw). */
const PTH = 0.026;
/** The wrapper's darkest color, for the pack's edges. */
const EDGE: Record<Kind, string> = { std: "#141a46", gold: "#5e3207", myth: "#04262e", test: "#23104a" };
/** CSS perspective(900px): the camera sits this far from the screen. */
const PERSP = 900;

const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const vec3 = (c: [number, number, number]) => `vec3(${c.map((x) => x.toFixed(4)).join(", ")})`;

/** CSS cubic-bezier timing, so the WebGL pack moves like the CSS one did. */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const f = (a: number, b: number, t: number) => 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t;
  return (x: number) => {
    if (x <= 0 || x >= 1) return x <= 0 ? 0 : 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 20; i++) { t = (lo + hi) / 2; if (f(x1, x2, t) < x) lo = t; else hi = t; }
    return f(y1, y2, t);
  };
}
const TURN = bezier(0.2, 1.3, 0.4, 1); // .op-rot's transition
const FLY = bezier(0.3, 0.7, 0.2, 1); // the strip coming away
const FALL = bezier(0.55, 0, 0.8, 0.4); // the empty pack dropping
const OUT = (k: number) => 1 - Math.pow(1 - k, 3);

export interface PackGL {
  /** Draws this kind's pack over `grip` (the DOM pack's box), following the CSS transforms of `follow` (the lift and the
      jolts, inside the grip). Resolves false if its picture can't be loaded. */
  show(kind: Kind, grip: HTMLElement, follow: HTMLElement[]): Promise<boolean>;
  /** The pack turned in your hand (CSS degrees). `live` follows your finger; otherwise it springs there. */
  turn(x: number, y: number, live: boolean): void;
  /** As far as the tear has come (from the side it started: `dir` 1 the left), the light's strength and color. */
  tear(len: number, dir: number, light: number, color: string): void;
  jolt(t: number): void;
  /** The dashed "cut here" line. */
  hint(on: boolean): void;
  /** Opened: the strip comes away the way it was torn. */
  open(): void;
  /** The empty pack drops away. */
  drop(): void;
  /** Stops drawing the pack. */
  hide(): void;
  /** A burst of light over a card turning over (`r` on screen), with sparks for the best ones. */
  flare(r: DOMRect, color: string, sparks: boolean): void;
  dispose(): void;
}

const VERT = `varying vec2 vUv; varying vec3 vPos; void main() { vUv = uv; vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export function createPackGL(canvas: HTMLCanvasElement, host: HTMLElement): PackGL | null {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    return null;
  }
  let lost = false;
  canvas.addEventListener("webglcontextlost", () => { lost = true; });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  const scene = new Scene(), camera = new PerspectiveCamera(50, 1, 10, 4000);
  let W = 1, H = 1;
  const resize = () => {
    W = host.clientWidth || innerWidth; H = host.clientHeight || innerHeight;
    renderer.setSize(W, H, false);
    // One unit is one CSS pixel where the pack is (z = 0), seen from as far as CSS's perspective(900px).
    camera.aspect = W / H;
    camera.fov = (2 * Math.atan(H / 2 / PERSP) * 180) / Math.PI;
    camera.position.set(0, 0, PERSP);
    camera.updateProjectionMatrix();
    wake();
  };

  // ---------- the pack ----------
  const root = new Group(), turner = new Group();
  root.add(turner);
  root.visible = false;
  scene.add(root);
  const loader = new TextureLoader(), pics = new Map<Kind, Promise<Texture>>();
  const picture = (k: Kind) => {
    let p = pics.get(k);
    if (!p) {
      p = loader.loadAsync(`${import.meta.env.BASE_URL}gl/pack-${k}.webp`).then((t) => { t.minFilter = LinearFilter; t.generateMipmaps = false; t.anisotropy = 4; return t; });
      p.catch(() => pics.delete(k));
      pics.set(k, p);
    }
    return p;
  };
  const u = {
    map: { value: null as Texture | null }, fade: { value: 1 }, sheen: { value: 0 },
    // The light: its color and strength, and the open part of the seam (pack pixels, from the left edge).
    color: { value: [1, 1, 1] }, light: { value: 0 }, x0: { value: 0 }, x1: { value: 0 },
    pw: { value: 1 }, ph: { value: 1 }, edge: { value: [0, 0, 0] }, hint: { value: 0 },
  };
  // The faces: the picture of the front (left half) or the back (right half), with the pack's moving sheen on the front.
  const face = (u0: number, v0: number, v1: number, sheen: boolean) => new ShaderMaterial({
    uniforms: u, transparent: true,
    vertexShader: VERT,
    fragmentShader: `uniform sampler2D map; uniform float fade; uniform float sheen; uniform float pw; uniform float ph; varying vec2 vUv;
      void main() {
        vec2 t = vec2(${u0.toFixed(2)} + vUv.x * 0.5, ${v0.toFixed(4)} + vUv.y * ${(v1 - v0).toFixed(4)});
        vec4 c = texture2D(map, t);
        if (c.a < 0.02) discard;
        ${sheen ? `// .op-psheen: a soft band at 105deg, 220% of the pack wide, sliding as the pack turns.
        vec2 p = vec2(vUv.x, t.y);
        float d = (p.x - 0.5) * pw + (p.y - 0.5) * ph * 0.268 - sheen * pw * 2.2 / 100.0;
        c.rgb += 0.26 * max(0.0, 1.0 - abs(d) / (pw * 0.176));` : ""}
        gl_FragColor = vec4(c.rgb, c.a * fade);
      }`,
  });
  const body = new Mesh(new PlaneGeometry(1, 1), face(0, 0, 1 - SEAM, true));
  const back = new Mesh(new PlaneGeometry(1, 1), face(0.5, 0, 1, false));
  back.rotation.y = Math.PI;
  // Edges: layers of the wrapper's dark color between the faces, below the strip (like .op-pedge).
  const edgeMat = new ShaderMaterial({
    uniforms: u, transparent: true, vertexShader: VERT,
    fragmentShader: `uniform vec3 edge; uniform float fade; uniform float pw; uniform float ph; varying vec2 vUv;
      void main() {
        // Square at the top, rounded at the bottom corners like the pack.
        vec2 p = vec2((vUv.x - 0.5) * pw * 0.992, vUv.y * ph * 0.872);
        float r = pw * 0.04;
        vec2 q = vec2(abs(p.x) - (pw * 0.496 - r), r - p.y);
        if (q.x > 0.0 && q.y > 0.0 && length(q) > r) discard;
        gl_FragColor = vec4(edge, fade);
      }`,
  });
  const edges = Array.from({ length: 7 }, () => new Mesh(new PlaneGeometry(1, 1), edgeMat));
  // The strip: a band of points along the seam, bent each frame from the wrapper's chain. Its inside is foil-grey.
  const R = 3, wrap = wrapper(false), n = wrap.n;
  const sGeo = new BufferGeometry(), sPos = new Float32Array((n + 1) * (R + 1) * 3), sUv = new Float32Array((n + 1) * (R + 1) * 2), sShade = new Float32Array((n + 1) * (R + 1));
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= R; j++) {
    const v = i * (R + 1) + j;
    sUv[v * 2] = (i / n) * 0.5; sUv[v * 2 + 1] = 1 - SEAM + (j / R) * SEAM;
    if (i < n && j < R) idx.push(v, v + R + 1, v + 1, v + 1, v + R + 1, v + R + 2);
  }
  sGeo.setAttribute("position", new BufferAttribute(sPos, 3));
  sGeo.setAttribute("uv", new BufferAttribute(sUv, 2));
  sGeo.setAttribute("shade", new BufferAttribute(sShade, 1));
  sGeo.setIndex(idx);
  const sfade = { value: 1 };
  const strip = new Mesh(sGeo, new ShaderMaterial({
    uniforms: { ...u, sfade }, transparent: true, side: DoubleSide,
    vertexShader: `attribute float shade; varying vec2 vUv; varying float vShade; void main() { vUv = uv; vShade = shade; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform sampler2D map; uniform float fade; uniform float sfade; varying vec2 vUv; varying float vShade;
      void main() {
        vec4 c = texture2D(map, vUv);
        if (c.a < 0.02) discard;
        vec3 col = gl_FrontFacing ? c.rgb * vShade : vec3(0.72, 0.78, 0.86) * vShade;
        gl_FragColor = vec4(col, c.a * fade * sfade);
      }`,
  }));
  const stripBox = new Group();
  stripBox.add(strip);
  // The light inside the pack, coming out of the gap: a glow rising from the seam, rays, a bright torn edge. Added to
  // what's behind, and only where the strip has come away.
  const glow = new Mesh(new PlaneGeometry(1, 1), new ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false, blending: CustomBlending, blendSrc: OneFactor, blendDst: OneFactor,
    vertexShader: VERT,
    fragmentShader: `uniform vec3 color; uniform float light; uniform float x0; uniform float x1; uniform float pw; uniform float ph; uniform float fade; varying vec2 vUv;
      void main() {
        float x = vUv.x * pw * 1.2 - pw * 0.1, y = vUv.y * ph * 0.42;
        float open = smoothstep(x0 - 4.0, x0 + 8.0, x) * (1.0 - smoothstep(x1 - 8.0, x1 + 4.0, x)) * smoothstep(-6.0, 6.0, x) * (1.0 - smoothstep(pw - 6.0, pw + 6.0, x));
        float v = vUv.y;
        float rise = pow(1.0 - min(1.0, v / 0.72), 2.2) * 0.9;
        float lean = (x - (x0 + x1) * 0.5) * 0.25 * v;
        float rays = pow(0.5 + 0.5 * cos((x - lean) / 26.0 * 6.2832), 5.0) * (1.0 - v) * 0.45;
        float edge = exp(-y * 0.45) * 1.5;
        float a = clamp(light * fade * open * (rise + rays + edge), 0.0, 1.6);
        gl_FragColor = vec4(color * a, 0.0);
      }`,
  }));
  // "Cut here": the dashed line and scissors of .op-cutzone, drawn once on a canvas.
  const hintCv = document.createElement("canvas");
  const hintTex = new CanvasTexture(hintCv);
  const hintMesh = new Mesh(new PlaneGeometry(1, 1), new ShaderMaterial({
    uniforms: { map: { value: hintTex }, hint: u.hint, fade: u.fade }, transparent: true, depthWrite: false,
    vertexShader: VERT,
    fragmentShader: `uniform sampler2D map; uniform float hint; uniform float fade; varying vec2 vUv; void main() { vec4 c = texture2D(map, vUv); gl_FragColor = vec4(c.rgb, c.a * hint * fade); }`,
  }));
  // Its shadow on the floor (.op-pbody's box-shadow), which doesn't turn with it.
  const shadow = new Mesh(new PlaneGeometry(1, 1), new ShaderMaterial({
    uniforms: u, transparent: true, depthWrite: false, vertexShader: VERT,
    fragmentShader: `uniform float fade; uniform float pw; uniform float ph; varying vec2 vUv;
      void main() {
        vec2 p = (vUv - 0.5) * vec2(pw + 100.0, ph + 100.0);
        vec2 q = abs(p) - vec2(pw, ph * ${(1 - SEAM).toFixed(3)}) * 0.5 + 10.0;
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 10.0;
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.55 * fade * (1.0 - smoothstep(-25.0, 25.0, d)));
      }`,
  }));
  turner.add(body, back, ...edges, glow, stripBox, hintMesh);
  root.add(shadow);
  shadow.renderOrder = -1;
  glow.renderOrder = 2;
  hintMesh.renderOrder = 3;

  let PW = 1, PH = 1, kind: Kind = "std";
  let grip: HTMLElement | null = null, follow: HTMLElement[] = [];
  /** Sizes everything to the DOM pack. */
  const build = () => {
    const r = grip!.getBoundingClientRect();
    PW = r.width; PH = r.height;
    u.pw.value = PW; u.ph.value = PH;
    const T = PW * PTH, HB = PH * (1 - SEAM), seamY = PH / 2 - PH * SEAM;
    body.scale.set(PW, HB, 1); body.position.set(0, -PH / 2 + HB / 2, T);
    back.scale.set(PW, PH, 1); back.position.set(0, 0, -T);
    edges.forEach((e, i) => { e.scale.set(PW * 0.992, PH * 0.872, 1); e.position.set(0, -PH / 2 + PH * 0.437, (T * (i - 3)) / 4); });
    glow.scale.set(PW * 1.2, PH * 0.42, 1); glow.position.set(0, seamY + PH * 0.21, 0);
    shadow.scale.set(PW + 100, PH + 100, 1); shadow.position.set(0, -24 - (PH * SEAM) / 2, -T * 2);
    // The hint, at the CSS's place: 6% in from each side, from 7% to 17% down.
    const dpr = 2, hw = PW * 0.88 + 24, hh = PH * 0.1 + 24;
    hintCv.width = Math.round(hw * dpr); hintCv.height = Math.round(hh * dpr);
    const c = hintCv.getContext("2d")!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, hw, hh);
    c.strokeStyle = "rgba(255,255,255,.6)"; c.lineWidth = 2; c.setLineDash([6, 4]);
    c.beginPath(); c.roundRect(13, 13, hw - 26, hh - 26, 10); c.stroke();
    c.setLineDash([]);
    c.font = "18px system-ui, sans-serif"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = "#fff";
    c.shadowColor = "rgba(0,0,0,.7)"; c.shadowBlur = 4; c.shadowOffsetY = 1;
    c.fillText("✂", 12, hh / 2);
    hintTex.needsUpdate = true;
    hintMesh.scale.set(hw, hh, 1); hintMesh.position.set(0, PH / 2 - PH * 0.12, T + 1);
    bend();
  };
  /** Bends the strip to the wrapper's chain. */
  const bend = () => {
    const T = PW * PTH, SH = PH * SEAM, seamY = PH / 2 - SH, { px, py, pf } = wrap;
    for (let i = 0; i <= n; i++) {
      const a = i < n ? Math.atan2(py[i + 1] - py[i], px[i + 1] - px[i]) : Math.atan2(py[i] - py[i - 1], px[i] - px[i - 1]);
      const x = px[i] * PW - PW / 2, y = seamY + py[i] * PW, c = Math.cos(pf[i]), s = Math.sin(pf[i]);
      for (let j = 0; j <= R; j++) {
        const v = i * (R + 1) + j, h = (j / R) * SH;
        sPos[v * 3] = x - Math.sin(a) * h * c;
        sPos[v * 3 + 1] = y + Math.cos(a) * h * c;
        sPos[v * 3 + 2] = T + h * s;
        sShade[v] = 0.62 + 0.38 * c;
      }
    }
    sGeo.attributes.position.needsUpdate = true;
    (sGeo.attributes.shade as BufferAttribute).needsUpdate = true;
    sGeo.computeBoundingSphere();
  };
  /** The light's open part of the seam, from the tear. */
  const opening = () => {
    const t = wrap.tear, d = wrap.dir;
    u.x0.value = d > 0 ? 0 : (1 - t) * PW;
    u.x1.value = d > 0 ? t * PW : PW;
  };

  // ---------- following the DOM pack ----------
  const rot = { x: 0, y: 0, fx: 0, fy: 0, tx: 0, ty: 0, t0: 0 };
  /** The pack's place: the grip's box, plus the CSS transforms of the lift and jolts inside it. */
  const place = () => {
    const c = canvas.getBoundingClientRect(), r = grip!.getBoundingClientRect();
    let m = new DOMMatrix(), op = 1;
    for (const el of follow) {
      const cs = getComputedStyle(el);
      if (cs.transform && cs.transform !== "none") m = m.multiply(new DOMMatrix(cs.transform));
      op *= +cs.opacity;
    }
    root.position.set(r.left + r.width / 2 + m.e - c.left - W / 2, H / 2 - (r.top + r.height / 2 + m.f - c.top), 0);
    root.rotation.z = -Math.atan2(m.b, m.a);
    root.scale.setScalar(Math.hypot(m.a, m.b) || 1);
    u.fade.value = op * fadeOut;
  };
  const moving = (els: HTMLElement[]) => els.some((el) => el.getAnimations().some((a) => a.playState === "running"));

  // ---------- flares ----------
  const flares: { m: Mesh; t0: number; ms: number }[] = [];
  const flareMat = (col: [number, number, number]) => new ShaderMaterial({
    uniforms: { k: { value: 0 } }, transparent: true, depthWrite: false, depthTest: false, blending: CustomBlending, blendSrc: OneFactor, blendDst: OneFactor,
    vertexShader: VERT,
    fragmentShader: `uniform float k; varying vec2 vUv;
      void main() { float d = length(vUv - 0.5) * 2.0; float a = (1.0 - k) * (exp(-d * d * 6.0) * 0.9 + exp(-d * d * 40.0) * 0.8); gl_FragColor = vec4(mix(${vec3(col)}, vec3(1.0), 0.35) * a, 0.0); }`,
  });
  const sparks: { p: Points; t0: number }[] = [];
  const sparkPoints = (col: [number, number, number], size: number) => {
    const N = 90, g = new BufferGeometry(), d = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { const a = Math.random() * Math.PI * 2, s = 0.5 + Math.random(); d.set([Math.cos(a) * s, Math.sin(a) * s, Math.random()], i * 3); }
    g.setAttribute("position", new BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute("dir", new BufferAttribute(d, 3));
    return new Points(g, new ShaderMaterial({
      uniforms: { t: { value: 0 }, size: { value: size }, px: { value: renderer.getPixelRatio() } }, transparent: true, depthWrite: false, depthTest: false,
      blending: CustomBlending, blendSrc: OneFactor, blendDst: OneFactor,
      vertexShader: `attribute vec3 dir; uniform float t; uniform float size; uniform float px; varying float vA;
        void main() { vec3 p = dir * (1.0 - pow(1.0 - t, 3.0)) * size; p.y -= t * t * size * 0.3; vA = (1.0 - t) * step(0.001, t);
          gl_PointSize = (3.0 + 4.0 * (1.0 - t)) * px; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }`,
      fragmentShader: `varying float vA; void main() { float d = length(gl_PointCoord - 0.5); float a = vA * smoothstep(0.5, 0.1, d); gl_FragColor = vec4(mix(${vec3(col)}, vec3(1.0), 0.4) * a, 0.0); }`,
    }));
  };

  // ---------- drawing only while something moves ----------
  type Tween = { t0: number; ms: number; fn: (k: number) => void };
  const tweens: Tween[] = [];
  const tween = (ms: number, fn: (k: number) => void) => { tweens.push({ t0: performance.now(), ms, fn }); wake(); };
  let raf = 0, last = 0, fadeOut = 1, showing = false, settling = false;
  const frame = (now: number) => {
    raf = 0;
    if (lost) return;
    const dt = Math.min(2, last ? (now - last) / 16.7 : 1);
    last = now;
    let busy = false;
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i], k = Math.min(1, (now - tw.t0) / tw.ms);
      tw.fn(k);
      if (k >= 1) tweens.splice(i, 1); else busy = true;
    }
    if (showing) {
      if (settling) { settling = wrap.step(dt); bend(); busy ||= settling; }
      if (rot.t0) {
        const k = Math.min(1, (now - rot.t0) / 500), e = TURN(k);
        rot.x = rot.fx + (rot.tx - rot.fx) * e; rot.y = rot.fy + (rot.ty - rot.fy) * e;
        if (k >= 1) rot.t0 = 0; else busy = true;
      }
      turner.rotation.set((-rot.x * Math.PI) / 180, (rot.y * Math.PI) / 180, 0);
      u.sheen.value = -Math.sin((rot.y * Math.PI) / 180) * 60;
      if (grip?.isConnected) { place(); busy ||= moving(follow) || moving([host.querySelector<HTMLElement>(".op-stage") ?? host]); }
    }
    for (let i = flares.length - 1; i >= 0; i--) {
      const f = flares[i], k = Math.min(1, (now - f.t0) / f.ms);
      (f.m.material as ShaderMaterial).uniforms.k.value = k;
      f.m.scale.setScalar(f.m.userData.s * (1 + OUT(k) * 1.6));
      if (k >= 1) { scene.remove(f.m); (f.m.material as ShaderMaterial).dispose(); flares.splice(i, 1); } else busy = true;
    }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i], k = Math.min(1, (now - s.t0) / 1100);
      (s.p.material as ShaderMaterial).uniforms.t.value = k;
      if (k >= 1) { scene.remove(s.p); s.p.geometry.dispose(); (s.p.material as ShaderMaterial).dispose(); sparks.splice(i, 1); } else busy = true;
    }
    renderer.render(scene, camera);
    if (busy) raf = requestAnimationFrame(frame); else last = 0;
  };
  function wake() { if (!raf && !lost) raf = requestAnimationFrame(frame); }
  addEventListener("resize", resize);
  resize();

  return {
    async show(k, g, f) {
      kind = k; grip = g; follow = f;
      let tex: Texture;
      try { tex = await picture(k); } catch { return false; }
      if (lost || grip !== g) return false;
      u.map.value = tex;
      u.edge.value = rgb(EDGE[kind]);
      u.light.value = 0; u.hint.value = 1; fadeOut = 1;
      wrap.set(0, 1);
      while (wrap.step(1)) { /* lie flat */ }
      rot.x = rot.y = rot.t0 = 0;
      turner.position.set(0, 0, 0); turner.rotation.set(0, 0, 0);
      stripBox.position.set(0, 0, 0); stripBox.rotation.set(0, 0, 0); sfade.value = 1;
      build(); opening();
      root.visible = showing = true;
      wake();
      return true;
    },
    turn(x, y, live) {
      if (live) { rot.x = x; rot.y = y; rot.t0 = 0; } else { rot.fx = rot.x; rot.fy = rot.y; rot.tx = x; rot.ty = y; rot.t0 = performance.now(); }
      wake();
    },
    tear(len, dir, light, color) {
      wrap.set(len, dir);
      u.light.value = light > 0 ? 0.35 + light * 0.75 : 0;
      u.color.value = rgb(color);
      opening();
      settling = true;
      wake();
    },
    jolt(t) { wrap.jolt(t); settling = true; wake(); },
    hint(on) {
      const from = u.hint.value, to = on ? 1 : 0;
      if (from !== to) tween(250, (k) => { u.hint.value = from + (to - from) * k; });
    },
    open() {
      // The light at full across the whole top; the strip folds on over and flies off the way it was torn.
      const d = wrap.dir, l0 = u.light.value, a0 = u.x0.value, a1 = u.x1.value;
      u.hint.value = 0;
      tween(650, (k) => {
        const e = FLY(k);
        stripBox.position.set(d * PW * 0.34 * e, PH * 0.14 * e, PW * 0.3 * e);
        stripBox.rotation.set(-0.5 * e, 0, -d * 0.3 * e);
        sfade.value = 1 - e;
        u.light.value = l0 + (1.6 - l0) * Math.min(1, k * 3);
        u.x0.value = d > 0 ? 0 : a0 * (1 - e);
        u.x1.value = d > 0 ? a1 + (PW - a1) * e : PW;
      });
    },
    drop() {
      const y0 = turner.position.y;
      tween(550, (k) => {
        const e = FALL(k);
        turner.position.y = y0 - PH * 1.15 * e;
        turner.rotation.z = (-4 * Math.PI * e) / 180;
        fadeOut = 1 - e;
        u.fade.value = fadeOut;
        if (k >= 1) root.visible = showing = false;
      });
    },
    hide() { root.visible = showing = false; grip = null; wake(); },
    flare(r, color, big) {
      const c = canvas.getBoundingClientRect(), col = rgb(color);
      const x = r.left + r.width / 2 - c.left - W / 2, y = H / 2 - (r.top + r.height / 2 - c.top);
      const m = new Mesh(new PlaneGeometry(1, 1), flareMat(col));
      m.userData.s = Math.max(r.width, r.height) * (big ? 1.5 : 1.15);
      m.position.set(x, y, 40); m.renderOrder = 10;
      scene.add(m);
      flares.push({ m, t0: performance.now(), ms: big ? 900 : 650 });
      if (big) {
        const p = sparkPoints(col, r.width * 1.3);
        p.position.set(x, y, 50); p.renderOrder = 11;
        scene.add(p);
        sparks.push({ p, t0: performance.now() });
      }
      wake();
    },
    dispose() {
      cancelAnimationFrame(raf);
      removeEventListener("resize", resize);
      for (const f of flares) (f.m.material as ShaderMaterial).dispose();
      scene.traverse((o) => { if (o instanceof Mesh || o instanceof Points) { o.geometry.dispose(); (o.material as ShaderMaterial).dispose(); } });
      hintTex.dispose();
      for (const p of pics.values()) p.then((t) => t.dispose(), () => {});
      renderer.dispose();
    },
  };
}

import { useLayoutEffect, useRef } from "preact/hooks";
import type { RefObject } from "preact";
import type { Reveal } from "./reveal";

type Point = { x: number; y: number };
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function AbilityAnimation({ board, active }: {
  board: RefObject<HTMLDivElement>;
  active: NonNullable<Reveal["ability"]>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const el = board.current;
    const layer = canvas.current;
    const { activation, duration, finish } = active;
    if (!el || !layer) { finish(); return; }
    const card = (inst: number) => el.querySelector<HTMLElement>(`[data-robot="${inst}"] .b-bot-card`);
    const source = card(activation.source);
    if (!source) { finish(); return; }
    const targets = activation.targets.filter((inst) => inst !== activation.source).map(card)
      .filter((target): target is HTMLElement => target !== null);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const text = source.querySelector(".effect p");
    const clip = source.querySelector(".effect");
    const animations: Animation[] = [];
    source.classList.add("b-ability-source");
    clip?.classList.add("b-ability-text");
    if (!reduced) {
      animations.push(source.animate([
        { transform: "rotate(0)" }, { transform: "rotate(-4deg) scale(1.03)", offset: .11 },
        { transform: "rotate(4deg) scale(1.03)", offset: .22 }, { transform: "rotate(-2deg)", offset: .33 },
        { transform: "rotate(0)", offset: .44 }, { transform: "rotate(0)" },
      ], { duration, easing: "ease-out" }));
      if (text) animations.push(text.animate([
        { scale: 1 }, { scale: 1.32, offset: .23 }, { scale: 1.32, offset: .78 }, { scale: 1 },
      ], { duration, easing: "ease-in-out" }));
    }
    for (const target of targets) {
      animations.push(target.animate([
        { outlineColor: "transparent" }, { outlineColor: "#a3f4ff", offset: .22 }, { outlineColor: "transparent" },
      ], { delay: reduced ? 0 : duration * .65, duration: reduced ? duration : duration * .35 }));
      target.classList.add("b-ability-target");
    }

    const ctx = layer.getContext("2d");
    let frame = 0;
    const start = performance.now();
    if (ctx && !reduced && targets.length) {
      const draw = (time: number) => {
        const progress = (time - start) / duration;
        if (progress >= 1) return;
        const rect = layer.getBoundingClientRect();
        const scale = Math.min(devicePixelRatio || 1, 2);
        const width = Math.round(rect.width * scale), height = Math.round(rect.height * scale);
        if (layer.width !== width || layer.height !== height) { layer.width = width; layer.height = height; }
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        ctx.clearRect(0, 0, rect.width, rect.height);
        const anchor = (element: Element): Point => {
          const box = element.getBoundingClientRect();
          return { x: box.left - rect.left + box.width / 2, y: box.top - rect.top + box.height / 2 };
        };
        const from = anchor(text ?? source);
        const head = clamp((progress - .14) / .53);
        const tail = clamp((progress - .39) / .53);
        const center = { x: rect.width / 2, y: rect.height / 2 };
        if (head > tail) for (const target of targets) {
          const to = anchor(target);
          const dx = to.x - from.x, dy = to.y - from.y;
          const length = Math.hypot(dx, dy) || 1;
          const normal = dx < 0 ? -1 : 1;
          const bend = Math.min(66, length * .44);
          const project = (t: number) => {
            // The beam rises toward the viewer and then lands back on the plane of the cards.
            const lift = Math.sin(Math.PI * t);
            const perspective = 420 / (420 - 88 * lift);
            const x = from.x + dx * t + normal * dy / length * bend * lift;
            const y = from.y + dy * t - normal * dx / length * bend * lift;
            return { x: center.x + (x - center.x) * perspective, y: center.y + (y - center.y) * perspective, perspective };
          };
          ctx.lineCap = "round";
          for (let i = 0; i < 20; i++) {
            const a = project(tail + (head - tail) * i / 20);
            const b = project(tail + (head - tail) * (i + 1) / 20);
            ctx.globalAlpha = (.12 + .88 * i / 19) * (1 - clamp((progress - .70) / .25));
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.shadowColor = "#4fd8ff";
            ctx.shadowBlur = 12 * b.perspective;
            ctx.strokeStyle = "#67e4ff";
            ctx.lineWidth = 5 * b.perspective;
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.strokeStyle = "#eafcff";
            ctx.lineWidth = 2.4 * b.perspective;
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
        frame = requestAnimationFrame(draw);
      };
      frame = requestAnimationFrame(draw);
    }
    const timer = window.setTimeout(finish, duration);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      animations.forEach((animation) => animation.cancel());
      source.classList.remove("b-ability-source");
      clip?.classList.remove("b-ability-text");
      for (const target of targets) target.classList.remove("b-ability-target");
      finish();
    };
  }, [board, active]);

  return <canvas class="b-ability-beams" ref={canvas} aria-hidden="true" />;
}

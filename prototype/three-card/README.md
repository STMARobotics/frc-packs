# WebGL card prototype

One real card drawn with Three.js instead of CSS 3D: Mythic 2910 Jack in the Bot and Rare 111 WildStang. The card art is
captured from the live site, so the only difference is the renderer.

- Hold and drag to turn it. The physics are the site's own (`useGrabTilt` in `web/src/site/ui.tsx`): at most 20°,
  0.3° per pixel, and the same spring back. It renders only while it moves, so nothing moves on its own.
- **Mythic**: rainbow foil biased to teal, strongest on the frame, with glints that change only as the card turns.
- **Rare**: one gold band that sweeps across as you turn it.
- **Both**: a light that follows your finger, rounded corners and anti-aliased edges, a soft shadow, and a
  constellation card back on the same object.

Open `index.html` through any local web server. Three.js r160 loads from jsDelivr.

## Cost

| | Gzipped JS a phone downloads |
| --- | --- |
| Today, the whole app (main, runtime, API) | ~51 KB |
| Three.js, only what this card needs (Vite production build) | **+118 KB** |
| React Three Fiber (React + R3F + all of Three) | **+269 KB** |

On a mid-range phone profile (390×844, 3× pixels, CPU slowed 4×, dragging continuously for 3 s), both renderers draw a
frame in about 6 ms:

| | Frame rate (uncapped, headless) | Slowest 5% of frames | Frames over 33 ms |
| --- | --- | --- | --- |
| CSS card, 2910 / 111 | 168 / 168 fps | 6.2 / 6.1 ms | 0 / 0 |
| WebGL card, 2910 / 111 | 169 / 169 fps | 6.1 / 6.1 ms | 0 / 0 |

Headless Chrome doesn't cap at 60 fps, so these numbers are headroom; a phone shows 60 or 120 either way. The WebGL
numbers use this PC's GPU (through ANGLE). On a real low-end phone the GPU and battery are what WebGL costs, which this
test can't show. Raw numbers are in `css-fps.json` and `webgl-fps.json`.

## Files

- `index.html`: the prototype.
- `capture.cjs`: captures the faces from a local server and measures the CSS card.
- `measure.cjs`: measures the WebGL card and saves `shots/webgl-*.png`.
- `shots/compare-2910.png` and `shots/compare-111.png`: side by side, at the same angle.

Not built: a WebGL pack rip. The current canvas rip already does the tear, and a WebGL one would mean cloth physics
for little visible gain.

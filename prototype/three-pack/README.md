# WebGL pack-opening prototype

The real Championship pack art and one real card of each rarity, opened with Three.js.

1. **Tear:** swipe across the top. The strip above the seam peels up toward you as far as your finger has gone, and
   the light comes out only where it has lifted, in the colour of the best card inside. Let go before about 70% and
   it closes again, like today's pack.
2. **Open:** finish the tear and the strip comes away with a flare of light. The cards rise out from inside the pack
   (behind its front), and the pack drops away.
3. **Reveal:** tap through the cards, worst first. Common and Uncommon come face up. Rare, Legendary and Mythic come
   face down and turn over with a burst in their colour; the Mythic also throws teal sparks. Drag a card to tilt it
   for its foil.
4. **The pull:** every card fanned like a hand, the best one on top, and Open another.

It only draws while something moves (your finger, or an animation you started), so nothing moves on its own. The page
offers three packs: a Mythic, a Legendary or a Rare inside. There is one face per rarity, so the Legendary and Rare
packs have 4 and 3 cards.

## Cost

- **Three.js:** +118 KB gzipped, the same as the card prototype (they would share it).
- **This opening's code:** +6 KB gzipped (20 KB raw).
- **For comparison:** today's whole app is ~51 KB.

On a mid-range phone profile (390×844, 3× pixels, CPU slowed 4×), the tear and opening animation draw a frame in about
6 ms (`webgl-fps.json`). That is the same as today's CSS card, and well inside 16.7 ms. On a real low-end phone, GPU
work and battery are the costs this can't show.

## Not in it yet

- The sounds and haptics.
- The softbody wobble.
- The real pull summary (new/duplicate badges, serials).
- Picking a pack from the stack.

## Files

- `index.html`: the prototype. Open it through any local web server.
- `capture.cjs`: captures the textures from a local server.
- `measure.cjs`: plays it through and saves `shots/`. `shots/contact.png` shows every step.

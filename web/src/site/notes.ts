// The app's version and its patch notes, newest first. Bump VERSION and add a release at the top with each update
// players should hear about: everyone who's played before sees the newest one once (screens/notes.tsx), and Settings
// shows the version and every release. 0.x while in beta: the middle number for a weekly release, the last for the
// feedback updates and fixes in between.
export const VERSION = "0.11.0";

export interface Release { v: string; date: string; title: string; items: string[] }

export const NOTES: Release[] = [
  {
    v: "0.11.0",
    date: "2026-11-02",
    title: "Your feedback, round one",
    items: [
      "A new look: a cleaner typeface everywhere and a new logo.",
      "Every card shows its robot's Battler stats, the same ones it plays with.",
      "Who has it?: tap any card to see who else has it, spares first, and ask them for it.",
      "Sort your binder by copies, lowest serial, team number or name, and a compact view that fits five across.",
      "Serial numbers on other players' cards, and in the trade picker.",
      "Trading: see how many copies you have of every card in an offer, your spares come first, and a Spares filter.",
      "Fixed: \"isn't available to trade any more\" when asking for a card from someone's unfinished pack.",
      "Fixed: no robot photos when opening packs on iPhone.",
      "Fixed: NEW and COPY tags sometimes showing behind the cards.",
      "Fixed: a boosted pack looked like a standard one after reopening the app.",
      "The Open tab puts your pack first, with a big Claim button when free packs are waiting.",
      "Missions: one bigger challenge every day, and no more freebies.",
      "Battle has the same tab bar as everything else, and the queue timer counts every second.",
      "Battle: 7028 has the third-best auto in 2026, and its card shows it. Its new effect, Bump n Dump, knocks the other alliance's auto down, and with a Limelight or a Swerve Module (L1) attached, boosts yours.",
      "Battle: two parts are renamed: AprilTag Camera is now Limelight, and Swerve Module is now Swerve Module (L1).",
    ],
  },
  {
    v: "0.10.1",
    date: "2026-10-29",
    title: "Opening fixes",
    items: [
      "The light shows through the tear again, brighter.",
      "The pack is solid from every angle when you turn it.",
      "No more square shadows at the corners of cards and packs, or a foggy edge on glowing cards.",
      "NEW and COPY tags sit on top of the cards in your pull.",
    ],
  },
  {
    v: "0.10.0",
    date: "2026-10-29",
    title: "Packs in 3D",
    items: [
      "Opening a pack is in 3D now: the foil tears where you swipe, the light pours out, and the cards rise out of the pack.",
      "No wait after the tear: your pack's cards are ready the moment you pick it up.",
      "Cards turn over in 3D, and your pull fans out like a hand at the end. Tap a card to see it.",
      "A new logo.",
      "The rarity stars sit in the same place on every card.",
    ],
  },
  {
    v: "0.9.0",
    date: "2026-10-29",
    title: "A whole new FRC Packs",
    items: [
      "A new look on every screen, built for your phone.",
      "Packs rip the way you swipe them, and rewind if you let go.",
      "Mythics glow teal, special editions shine gold.",
      "A fairer Mythic meter: every pack is 1 in 250 for a Mythic (was 1 in 400), the meter helps after 200 packs and makes sure of one by 300.",
      "New constellation pack art.",
      "Battle: Quick Play, private matches with a code, and wagers between friends.",
      "Profiles are pages of their own: pick cards for your picture and banner, write a bio, pin your showcase.",
      "Trading: good matches with a fair offer ready to send, \"You need\" on anyone's cards, and counter-offers.",
      "Copies: see every copy of a card, its serial and where it came from, and trade or scrap the exact one you want.",
      "A bug report or idea that gets accepted earns you a free pack.",
      "Patch notes, right here.",
    ],
  },
  {
    v: "0.8.0",
    date: "2026-10-21",
    title: "Battle",
    items: [
      "The Battle tab: draft robots, build a deck and play a friend.",
      "Every card has battle stats on the back.",
    ],
  },
  {
    v: "0.7.0",
    date: "2026-10-16",
    title: "Mythics, rebalanced",
    items: [
      "Only 12 teams are Mythic now. Cards from other teams moved to their new tier.",
      "Tidier Settings.",
    ],
  },
];

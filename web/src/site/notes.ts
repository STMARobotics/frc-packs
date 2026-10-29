// The app's version and its patch notes, newest first. Bump VERSION and add a release at the top with each update
// players should hear about: everyone who's played before sees the newest one once (screens/notes.tsx), and Settings
// shows the version and every release. 0.x while in beta: the middle number for a weekly release, the last for the
// feedback updates and fixes in between.
export const VERSION = "0.9.0";

export interface Release { v: string; date: string; title: string; items: string[] }

export const NOTES: Release[] = [
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

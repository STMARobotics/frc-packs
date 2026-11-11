// The FRC Packs logo and wordmark, shared by the site and the Battler page (their styles are in nav.css).

/** The FRC Packs mark (Seam): a pack with its top torn open along one teal seam. The pack takes the text colour. The
    same drawing makes the favicon and app icons (tools/brand_icons.cjs). */
export const Logo = ({ cls }: { cls?: string }) => (
  <svg class={cls ? `s-logo ${cls}` : "s-logo"} viewBox="0 0 64 64" aria-hidden="true">
    <path d="M19 15.6 L45 6.9 Q47 6.3 47 8.4 L47 12.3 L17 22.3 L17 17.5 Q17 16.1 19 15.6 Z" fill="currentColor" />
    <path d="M17 24.6 L47 14.6 L47 19.8 L17 26 Z" fill="#3cffdc" />
    <path d="M17 28.6 L47 22.4 L47 47.6 L17 47.6 Z" fill="currentColor" />
    <path d="M17 50.2 H47 V52 Q47 56 43 56 H21 Q17 56 17 52 Z" fill="currentColor" />
  </svg>
);

/** The wordmark: FRC / Packs, the slash a teal seam. Read aloud as "FRC Packs". */
export const Wordmark = () => <span class="s-word" aria-label="FRC Packs">FRC<i class="s-slash" aria-hidden="true" />Packs</span>;

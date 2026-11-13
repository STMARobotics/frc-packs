export interface CardStats {
  auto: number;
  tele: number;
  end: number;
  def?: number | null;
  rp: [number, number, number];
}

export function formatRating(value?: number | null) {
  return value == null ? "–" : String(Math.floor(value));
}

export function formatRp(value: number) {
  return `${formatRating(value)}%`;
}

function Rating({ label, value }: { label: string; value?: number | null }) {
  return (
    <div class="stat">
      <small>{label}</small>
      <b class={value == null ? "na" : undefined}>{formatRating(value)}</b>
    </div>
  );
}

export function CardRatings({ stats }: { stats?: CardStats }) {
  return (
    <>
      <div class="statrow">
        <Rating label="AUTO" value={stats?.auto} />
        <Rating label="TELE" value={stats?.tele} />
        <Rating label="END" value={stats?.end} />
        <Rating label="DEF" value={stats?.def} />
      </div>
      <div class="rprow">
        {[0, 1, 2].map((i) => <div class="rp"><i>RP{i + 1}</i>{stats ? <b>{formatRp(stats.rp[i])}</b> : <b class="na">–</b>}</div>)}
      </div>
    </>
  );
}

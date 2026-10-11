import type { SiteFund } from "@/lib/types";
import { formatDate, money } from "@/lib/format";

const pct = (part: number, whole: number) => (whole > 0 ? Math.max(0, Math.min(100, Math.round((part / whole) * 100))) : 0);

/** Money into the fund is positive; purchases come out of it. */
function signed(t: SiteFund["transactions"][number]): number {
  const abs = Math.abs(t.amountCents);
  if (t.kind === "purchase") return -abs;
  if (t.kind === "transfer") return t.amountCents;
  return abs;
}

const KIND: Record<SiteFund["transactions"][number]["kind"], string> = { contribution: "added", purchase: "paid", refund: "refund", transfer: "transfer" };

const when = (iso: string) => formatDate(iso.slice(0, 10));

/** The group's shared trip fund: target, who's put in what, what's next, and what it paid for. */
export function TripFund({ fund }: { fund: SiteFund }) {
  const [bank, ...rest] = fund.accountLabel.split(" · ");
  const name = rest.join(" · ") || "Trip fund";
  const left = Math.max(0, fund.targetCents - fund.collectedCents);
  const p = pct(fund.collectedCents, fund.targetCents);
  return (
    <section className="fund" aria-labelledby="fund-title">
      <div className="fund-top">
        <div>
          <div className="fund-bank">{bank}</div>
          <h2 id="fund-title">{name}</h2>
        </div>
        <div className="fund-pct" aria-hidden="true">
          {p}%
        </div>
      </div>

      <p className="fund-amount">
        <strong>{money(fund.collectedCents)}</strong> <span className="muted">of {money(fund.targetCents)}</span>
      </p>
      <div className="meter" role="progressbar" aria-label="Collected" aria-valuemin={0} aria-valuemax={100} aria-valuenow={p}>
        <span style={{ width: `${p}%` }} />
      </div>
      <p className="small muted fund-sub">
        {left ? `${money(left)} to go` : "Fully funded ✓"}
        {fund.deadline ? ` · due by ${formatDate(fund.deadline)}` : ""}
      </p>

      {fund.members.length ? (
        <ul className="fund-members">
          {fund.members.map((m) => {
            const mp = pct(m.contributedCents, m.shareCents);
            const paid = m.shareCents > 0 && m.contributedCents >= m.shareCents;
            return (
              <li key={m.name}>
                <div className="fm-row">
                  <span className="fm-name">{m.name}</span>
                  <span className="fm-amt">
                    {money(m.contributedCents)} <span className="muted">/ {money(m.shareCents)}</span>
                  </span>
                </div>
                <div className="meter thin" aria-hidden="true">
                  <span style={{ width: `${mp}%` }} />
                </div>
                <div className="small muted">
                  {paid ? "Paid in full ✓" : m.nextCents ? `Next ${money(m.nextCents)}${m.nextDate ? ` · ${formatDate(m.nextDate, { weekday: "short", month: "short", day: "numeric" })}` : ""}` : "No installment scheduled"}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {fund.transactions.length ? (
        <>
          <h3 className="fund-h3">Activity</h3>
          <ul className="fund-tx">
            {fund.transactions.slice(0, 12).map((t, i) => {
              const v = signed(t);
              return (
                <li key={`${t.at}-${i}`}>
                  <span className="tx-date small muted">{when(t.at)}</span>
                  <span className="tx-label">
                    {t.label}
                    <span className="small muted"> · {KIND[t.kind]}</span>
                  </span>
                  <span className={`tx-amt ${v >= 0 ? "in" : "out"}`}>{v >= 0 ? `+${money(v)}` : money(v)}</span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}

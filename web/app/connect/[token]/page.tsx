// Bank-connect consent screen, opened from the link Atlas posts in the group ("here's yours maya 🔒").
// The token is verified here and again in the server action; nothing is shared until Connect.
import type { Metadata } from "next";
import { verifyConnectToken } from "@/lib/connectToken";
import { ConnectForm } from "./ConnectForm";
import { Notice, Shell } from "./Shell";
import s from "./connect.module.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect your account",
  description: "Share balances and recent transactions with Atlas, and pay into your trip fund.",
  robots: { index: false, follow: false, nocache: true },
  // The token is in the URL; don't hand it to anything this page links to.
  referrer: "no-referrer",
};

type Props = { params: Promise<{ token: string }> };

export default async function ConnectPage({ params }: Props) {
  const { token } = await params;
  const raw = decodeURIComponent(token);
  const check = verifyConnectToken(raw);

  if (!check.ok) {
    const expired = check.reason === "expired";
    return (
      <Shell>
        <Notice
          tone="warn"
          title={expired ? "This link has expired" : "This link doesn’t work"}
          body={
            <>
              Links only last 48 hours. Ask Atlas for a new one: say <strong>“connect me”</strong> in your group chat.
            </>
          }
        />
      </Shell>
    );
  }

  const name = check.payload.n || "you";
  const expires = new Date(check.payload.exp * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" });

  return (
    <Shell>
      <section className={s.card} aria-labelledby="consent-title">
        <div className={s.handshake} aria-hidden="true">
          <span className={s.badgeAtlas}>A</span>
          <span className={s.dots} />
          <span className={s.badgeBank}>C1</span>
        </div>
        <h1 id="consent-title" className={s.title}>
          Atlas wants to connect to your Capital One accounts
        </h1>
        <p className={s.as}>
          Connecting as <strong>{name}</strong> to Atlas
        </p>

        <h2 className={s.listTitle}>Atlas will be able to see</h2>
        <ul className={s.list}>
          <li>
            <span className={s.icon} aria-hidden="true">$</span>
            <div>
              <strong>Account balances</strong>
              <span>Checking and savings</span>
            </div>
          </li>
          <li>
            <span className={s.icon} aria-hidden="true">≡</span>
            <div>
              <strong>Transactions</strong>
              <span>The last 3 months, to suggest a trip budget you can afford</span>
            </div>
          </li>
        </ul>

        <div className={s.assure}>
          <p>
            <strong>You stay in control.</strong> Atlas only moves money for your trip-fund contributions on the schedule your group agrees to, and for settle-ups you confirm in the chat.
          </p>
          <p>
            <strong>Private.</strong> Your group only ever sees pooled numbers, never your balances or your budget.
          </p>
        </div>

        <ConnectForm token={raw} name={name} />

        <p className={s.fine}>
          Not ready? Close this page and tell Atlas a rough budget in the chat instead. This link expires {expires}.
        </p>
      </section>
    </Shell>
  );
}

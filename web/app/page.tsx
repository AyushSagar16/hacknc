import type { Metadata, Viewport } from "next";
import s from "./landing.module.css";
import { AtlasOrb } from "@/components/landing/AtlasOrb";
import { PhoneChat } from "@/components/landing/PhoneChat";
import { Reveal } from "@/components/landing/Reveal";
import { Scenery, type Place } from "@/components/landing/Scenery";
import { displayNumber, smsHref } from "@/lib/atlasLine";

const DESCRIPTION =
  "Atlas is a trip and money planner that lives in your iMessage group chat. Add its number: it finds where to go, runs the poll, books the stay on a shared fund and splits the bill.";

// Trip pages stay out of search; the homepage is the one page that should be found.
export const metadata: Metadata = {
  title: { absolute: "Atlas · Plan the trip. Split the bill. Stay friends." },
  description: DESCRIPTION,
  robots: { index: true, follow: true },
  openGraph: { siteName: "Atlas", title: "Atlas · Plan the trip. Split the bill. Stay friends.", description: DESCRIPTION },
};

// The landing page is always the light sky of the launch video.
export const viewport: Viewport = { themeColor: "#d7ecf8", colorScheme: "light" };

const STACK = ["Photon Spectrum", "Linq", "Capital One Nessie", "Gemini", "Tiger Data"];

// Positions in % of the hero; sizes in px.
const BUBBLES = [
  { x: 8, size: 70, dur: 26, delay: -4 },
  { x: 22, size: 120, dur: 34, delay: -20 },
  { x: 37, size: 48, dur: 22, delay: -9 },
  { x: 63, size: 90, dur: 30, delay: -14 },
  { x: 78, size: 140, dur: 38, delay: -2 },
  { x: 90, size: 60, dur: 24, delay: -17 },
  { x: 52, size: 36, dur: 20, delay: -6 },
];
const SPARKLES = [
  { x: 14, y: 20, size: 40, delay: 0 },
  { x: 86, y: 25, size: 32, delay: 0.6 },
  { x: 92, y: 66, size: 24, delay: 1.2 },
  { x: 5, y: 72, size: 26, delay: 1.8 },
];

function MessageIcon({ size = 30 }: { size?: number }) {
  return (
    <span className={s.msgIcon} style={{ width: size, height: size, borderRadius: size * 0.3 }} aria-hidden="true">
      <svg width={size * 0.56} height={size * 0.52} viewBox="0 0 30 28">
        <path
          d="M15 2C7.8 2 2 6.9 2 13c0 3.4 1.8 6.4 4.7 8.4-.3 1.9-1.3 3.6-2.7 4.6 2.8 0 5.2-1 6.9-2.6 1.3.4 2.7.6 4.1.6 7.2 0 13-4.9 13-11S22.2 2 15 2z"
          fill="#fff"
        />
      </svg>
    </span>
  );
}

function Sparkle({ x, y, size, delay }: { x: number; y: number; size: number; delay: number }) {
  return (
    <svg
      className={s.sparkle}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${delay}s` }}
      aria-hidden="true"
    >
      <path d="M50 0 C54 36 64 46 100 50 C64 54 54 64 50 100 C46 64 36 54 0 50 C36 46 46 36 50 0Z" fill="#fff" />
    </svg>
  );
}

/** The headline's words rise in one after another, like the video's Headline. */
function Words({ text, start = 0, accent = false }: { text: string; start?: number; accent?: boolean }) {
  return text.split(" ").map((w, i) => (
    <span key={i} className={`${s.word} ${accent ? s.accent : ""}`} style={{ animationDelay: `${0.25 + (start + i) * 0.07}s` }}>
      {w}{" "}
    </span>
  ));
}

function TextAtlas({ big = false }: { big?: boolean }) {
  return (
    <div className={s.ctaWrap}>
      <a className={`${s.cta} ${big ? s.ctaBig : ""}`} href={smsHref}>
        <MessageIcon size={big ? 44 : 36} />
        Add Atlas to your group chat
      </a>
      <p className={s.ctaNote}>
        Opens Messages to Atlas at <a href={smsHref}>{displayNumber()}</a>. Add your friends to make it a group.
      </p>
    </div>
  );
}

const OPTIONS: { place: Place; name: string; price: string; note: string; votes: number; won?: boolean }[] = [
  { place: "charleston", name: "Charleston", price: "~$520", note: "beach + big food scene", votes: 2, won: true },
  { place: "savannah", name: "Savannah", price: "~$555", note: "walkable, veg friendly", votes: 1 },
  { place: "wilmington", name: "Wilmington", price: "~$470", note: "beach, short drive", votes: 0 },
];

const STAGES = [
  ["Location", "Charleston"],
  ["Dates", "Nov 12–16"],
  ["Travel", "Driving"],
  ["Stay", "Harleston Village"],
  ["Food & fun", "6 picks"],
];

export default function Home() {
  return (
    <div className={`${s.landing} landing-page`} id="top">
      <Reveal />

      <header className={s.nav}>
        <a href="#top" className={s.navBrand} aria-label="Atlas, back to top">
          <AtlasOrb size={30} id="orb-nav" />
          Atlas
        </a>
        <nav className={s.navLinks} aria-label="Sections">
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href="#money">Money</a>
        </nav>
        <a href={smsHref} className={s.navCta}>
          <MessageIcon size={22} />
          Text Atlas
        </a>
      </header>

      {/* Hero: the launch video's end card. */}
      <section className={s.hero}>
        <div className={s.sky} aria-hidden="true">
          <div className={s.orbA} />
          <div className={s.orbB} />
          <div className={s.grid}>
            <div />
          </div>
          {BUBBLES.map((b, i) => (
            <span
              key={i}
              className={s.bubbleFloat}
              style={{ left: `${b.x}%`, width: b.size, height: b.size, animationDuration: `${b.dur}s`, animationDelay: `${b.delay}s` }}
            />
          ))}
          {SPARKLES.map((p, i) => (
            <Sparkle key={i} {...p} />
          ))}
        </div>

        <div className={s.brand}>
          <AtlasOrb size={150} id="orb-hero" className={s.heroOrb} />
          <span className={s.wordmark}>Atlas</span>
        </div>
        <h1 className={s.headline}>
          <span className={s.line}>
            <Words text="Plan the trip. Split the bill." />
          </span>
          <span className={s.line}>
            <Words text="Stay friends." start={6} accent />
          </span>
        </h1>
        <p className={s.heroSub}>
          A trip &amp; money planner that lives in your iMessage group chat. No app, no forms. Just text.
        </p>
        <TextAtlas />
      </section>

      {/* How it works, beside the chat from the video. */}
      <section className={`${s.section} ${s.how}`} id="how">
        <div className={`${s.howCopy} ${s.reveal}`} data-reveal>
          <p className={s.kicker}>
            <span className={s.kickerDot} />
            Introducing Atlas
          </p>
          <h2 className={s.h2}>
            Your group chat&apos;s <span className={s.accent}>new favorite member.</span>
          </h2>
          <p className={s.lede}>
            Every friend group has the thread: &ldquo;we should go somewhere,&rdquo; forty messages of maybes, then nothing.
            Atlas reads along and keeps the plan moving.
          </p>
          <ol className={s.steps}>
            <li>
              <span className={s.stepNum}>1</span>
              <div>
                <h3>Start a group chat</h3>
                <p>Make an iMessage group with the friends you&apos;re going with.</p>
              </div>
            </li>
            <li>
              <span className={s.stepNum}>2</span>
              <div>
                <h3>Add Atlas&apos;s number</h3>
                <p>It introduces itself, then reads along. Nothing to download, nobody to sign up.</p>
              </div>
            </li>
            <li>
              <span className={s.stepNum}>3</span>
              <div>
                <h3>Just talk</h3>
                <p>Atlas finds where to go, runs the poll, books the stay, plans the days and splits the bill.</p>
              </div>
            </li>
          </ol>
          <ul className={s.chips}>
            {["Where to go", "How to get there", "Where to stay", "Food & activities", "Who owes who"].map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
        <div className={s.phoneStage}>
          <Sparkle x={6} y={12} size={34} delay={0.4} />
          <Sparkle x={92} y={78} size={28} delay={1.4} />
          <PhoneChat />
        </div>
      </section>

      {/* Features, as the bento sheet. */}
      <section className={s.section} id="features">
        <div className={`${s.sectionHead} ${s.reveal}`} data-reveal>
          <p className={s.kicker}>
            <span className={s.kickerDot} />
            What it does
          </p>
          <h2 className={s.h2}>
            The friend who <span className={s.accent}>actually plans the trip.</span>
          </h2>
        </div>

        <div className={s.bento}>
          <article className={`${s.tile} ${s.w3} ${s.reveal}`} data-reveal>
            <p className={s.tileKicker}>Reads the conversation</p>
            <h3 className={s.tileTitle}>No forms. Just talk.</h3>
            <p className={s.tileBody}>
              Atlas picks up everyone&apos;s preferences and limits from normal texting, and keeps the words they came from.
            </p>
            <ul className={s.extract}>
              <li>
                <span className={s.quote}>cancun is too pricey for me</span>
                <span className={s.arrow} aria-hidden="true">→</span>
                <span className={s.tag}>💸 Maya · keep it cheaper</span>
              </li>
              <li>
                <span className={s.quote}>i&apos;m vegetarian</span>
                <span className={s.arrow} aria-hidden="true">→</span>
                <span className={s.tag}>🥗 Priya · vegetarian</span>
              </li>
              <li>
                <span className={s.quote}>i can&apos;t fly after the 14th</span>
                <span className={s.arrow} aria-hidden="true">→</span>
                <span className={s.tag}>📅 Leo · back by the 14th</span>
              </li>
            </ul>
          </article>

          <article className={`${s.tile} ${s.w3} ${s.navy} ${s.reveal}`} data-reveal>
            <p className={s.tileKicker}>Connected bank budgets</p>
            <h3 className={s.tileTitle}>Budgets from real account data.</h3>
            <ol className={s.budget}>
              <li>
                <span>1</span>What you earn<b>$3,700/mo</b>
              </li>
              <li>
                <span>2</span>Minus bills &amp; everyday spending<b>−$2,420/mo</b>
              </li>
              <li className={s.budgetTotal}>
                <span>3</span>Half of what&apos;s left, until the trip<b>$640</b>
              </li>
            </ol>
            <p className={s.tileBody}>
              Each person connects once. Atlas reads balances and recent transactions and suggests a budget they can actually
              afford, explained in three plain lines.
            </p>
          </article>

          <article className={`${s.tile} ${s.w4} ${s.sky2} ${s.reveal}`} data-reveal>
            <p className={s.tileKicker}>Where to go</p>
            <h3 className={s.tileTitle}>Priced options. Then a real poll.</h3>
            <p className={s.tileBody}>
              Three places that fit everyone&apos;s dates, diets, budgets and travel limits, each costed per person. A native
              iMessage poll decides.
            </p>
            <ul className={s.options}>
              {OPTIONS.map((o) => (
                <li key={o.place} className={`${s.option} ${o.won ? s.won : ""}`}>
                  <div className={s.optionArt}>
                    <Scenery place={o.place} height="100%" />
                    {o.won ? <span className={s.chosen}>✓ Chosen</span> : null}
                  </div>
                  <div className={s.optionBody}>
                    <strong>{o.name}</strong>
                    <span className={s.optionPrice}>{o.price}/person</span>
                    <span className={s.optionNote}>{o.note}</span>
                    <span className={s.optionVotes}>
                      {o.votes} vote{o.votes === 1 ? "" : "s"}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </article>

          <article className={`${s.tile} ${s.w2} ${s.reveal}`} data-reveal>
            <p className={s.tileKicker}>Reads the room</p>
            <h3 className={s.tileTitle}>Knows when to stay quiet.</h3>
            <p className={s.tileBody}>
              Most messages in a group chat aren&apos;t for Atlas, and it can tell. It chimes in when the trip or money comes up
              and stays out of the banter.
            </p>
            <div className={s.miniChat}>
              <p className={`${s.mini} ${s.miniGray}`}>did anyone see the game last night 😭</p>
              <p className={`${s.mini} ${s.miniBlue}`}>atlas stay quiet</p>
            </div>
            <p className={s.tileFoot}>&ldquo;atlas stay quiet&rdquo; mutes it.</p>
          </article>

          <article className={`${s.tile} ${s.w2} ${s.reveal}`} data-reveal>
            <p className={s.tileKicker}>Trip fund</p>
            <h3 className={s.tileTitle}>Paid on everyone&apos;s payday.</h3>
            <div className={s.fund}>
              <div className={s.fundTop}>
                <span>Charleston Trip Fund</span>
                <b>100%</b>
              </div>
              <div className={s.fundAmount}>
                <strong>$1,240</strong> of $1,240
              </div>
              <div className={s.meter}>
                <span />
              </div>
              <ul className={s.fundPeople}>
                {["Maya", "Leo", "Priya"].map((n) => (
                  <li key={n}>
                    {n}
                    <b>$413.33 ✓</b>
                  </li>
                ))}
              </ul>
            </div>
            <p className={s.tileBody}>The stay is booked on a shared fund everyone fills in small payments on their paydays.</p>
          </article>

          <article className={`${s.tile} ${s.w2} ${s.reveal}`} data-reveal>
            <p className={s.tileKicker}>Split &amp; settle</p>
            <h3 className={s.tileTitle}>&ldquo;i paid 90 for dinner&rdquo;</h3>
            <div className={s.miniChat}>
              <p className={`${s.mini} ${s.miniBlue}`}>i paid 90 for dinner</p>
              <p className={`${s.mini} ${s.miniGray}`}>logged #1: dinner $90.00, paid by maya. leo and priya owe maya $30.00 each</p>
            </div>
            <ul className={s.transfers}>
              <li>
                leo → maya <b>$60.00</b>
              </li>
              <li>
                leo → priya <b>$10.00</b>
              </li>
            </ul>
            <p className={s.tileFoot}>Fewest possible transfers. Nothing moves until the payer confirms.</p>
          </article>

          <article className={`${s.tile} ${s.w2} ${s.reveal}`} data-reveal>
            <p className={s.tileKicker}>Watches the forecast</p>
            <h3 className={s.tileTitle}>Rain on Saturday? Plan B.</h3>
            <ul className={s.forecast} aria-label="Forecast">
              {[
                ["Thu", "☀️"],
                ["Fri", "⛅"],
                ["Sat", "🌧️"],
                ["Sun", "☀️"],
              ].map(([d, e]) => (
                <li key={d} className={d === "Sat" ? s.rainy : ""}>
                  <span>{e}</span>
                  {d}
                </li>
              ))}
            </ul>
            <div className={s.miniChat}>
              <p className={`${s.mini} ${s.miniGray}`}>
                saturday flipped to rain, want to swap the beach day for the food market tour?
              </p>
            </div>
          </article>

          <article className={`${s.tile} ${s.w4} ${s.reveal}`} data-reveal>
            <div className={s.pageTile}>
              <div>
                <p className={s.tileKicker}>Every trip gets a page</p>
                <h3 className={s.tileTitle}>The whole plan, one link.</h3>
                <p className={s.tileBody}>
                  Where you&apos;re staying, where to eat, the day-by-day plan and the fund, on the trip&apos;s own page. Atlas
                  drops the link in the chat with a preview card.
                </p>
              </div>
              <div className={s.browser}>
                <div className={s.browserBar}>
                  <i />
                  <i />
                  <i />
                  <span>planwithatlas.tech</span>
                </div>
                <div className={s.browserHero}>
                  <Scenery place="charleston" height="100%" />
                  <div className={s.browserCaption}>
                    <strong>Charleston</strong>
                    <span>Nov 12–16 · Maya, Leo &amp; Priya</span>
                  </div>
                </div>
                <ol className={s.stageBar}>
                  {STAGES.map(([label, detail]) => (
                    <li key={label}>
                      <i />
                      <span>{label}</span>
                      <small>{detail}</small>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </article>

          <article className={`${s.tile} ${s.w2} ${s.sky2} ${s.reveal}`} data-reveal>
            <p className={s.tileKicker}>Memory</p>
            <h3 className={s.tileTitle}>Remembers what everyone said.</h3>
            <p className={s.tileBody}>
              Weeks later, Atlas still knows who&apos;s vegetarian and who can&apos;t fly after the 14th. It remembers its own words
              too, so it never nags twice.
            </p>
            <AtlasOrb size={84} id="orb-memory" className={s.memoryOrb} />
          </article>
        </div>
      </section>

      {/* Money and trust. */}
      <section className={s.section} id="money">
        <div className={`${s.trust} ${s.reveal}`} data-reveal>
          <div className={s.trustHead}>
            <p className={`${s.kicker} ${s.kickerDark}`}>
              <span className={s.kickerDot} />
              Money you can trust
            </p>
            <h2 className={s.h2}>Every dollar checks out.</h2>
          </div>
          <div className={s.trustGrid}>
            <div>
              <h3>Private by default</h3>
              <p>
                The group only sees the pooled per-person budget. Text Atlas yourself to see your own breakdown, and share it only
                if you want to.
              </p>
            </div>
            <div>
              <h3>Every figure is traced</h3>
              <p>
                Each dollar amount Atlas sends comes from a bank call or a labeled estimate. A money guard blocks anything else
                from going out.
              </p>
            </div>
            <div>
              <h3>The AI only does language</h3>
              <p>
                Money, constraints, polls and schedules are plain, deterministic code. The model writes the messages, never the
                math.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Closing call to action. */}
      <section className={`${s.section} ${s.final}`}>
        <div className={`${s.finalCard} ${s.reveal}`} data-reveal>
          <Sparkle x={8} y={18} size={30} delay={0.2} />
          <Sparkle x={90} y={70} size={26} delay={1} />
          <AtlasOrb size={96} id="orb-final" className={s.heroOrb} />
          <h2 className={s.h2}>
            Stop planning in circles. <span className={s.accent}>Text Atlas.</span>
          </h2>
          <p className={s.lede}>Add it to the group you already have. It takes it from there.</p>
          <TextAtlas big />
        </div>
      </section>

      <footer className={s.footer}>
        <div className={s.footBrand}>
          <AtlasOrb size={24} id="orb-foot" />
          Atlas
        </div>
        <p className={s.stack}>
          <span>Built on</span>
          {STACK.map((t, i) => (
            <span key={t}>
              {i ? <i aria-hidden="true">·</i> : null}
              {t}
            </span>
          ))}
        </p>
        <p className={s.fine}>Budgets in this demo come from Capital One sandbox data, never anyone&apos;s real bank.</p>
      </footer>
    </div>
  );
}

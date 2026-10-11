import s from "@/app/landing.module.css";
import { AtlasOrb } from "./AtlasOrb";

// A still of the launch video's group chat: Maya asks, Atlas offers three priced options, the
// group votes in a native poll and the trip is locked. Messages pop in one by one when the phone
// scrolls into view (see Reveal).
type Who = "maya" | "leo" | "priya" | "atlas";

const NAMES: Record<Who, string> = { maya: "Maya", leo: "Leo", priya: "Priya", atlas: "Atlas" };

function Avatar({ who, size = 28 }: { who: Who; size?: number }) {
  if (who === "atlas") return <AtlasOrb size={size} id={`chat-av-${size}`} />;
  return (
    <span className={s.avatar} style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden="true">
      {NAMES[who][0]}
    </span>
  );
}

function Row({ who, i, children, name = true }: { who: Who; i: number; children: React.ReactNode; name?: boolean }) {
  const mine = who === "maya";
  return (
    <div className={`${s.msg} ${mine ? s.mine : ""}`} style={{ ["--i" as string]: i }}>
      {!mine && name ? <div className={s.sender}>{NAMES[who]}</div> : null}
      <div className={s.msgLine}>
        {mine ? null : <Avatar who={who} />}
        {children}
      </div>
    </div>
  );
}

const POLL: { label: string; votes: Who[] }[] = [
  { label: "Charleston", votes: ["maya", "leo"] },
  { label: "Savannah", votes: ["priya"] },
  { label: "Wilmington", votes: [] },
];

export function PhoneChat() {
  return (
    <div className={`${s.phone} ${s.reveal}`} data-reveal role="img" aria-label="An iMessage group chat where Atlas offers three trip options and runs a poll">
      <div className={s.screen}>
        <div className={s.chatHead}>
          <div className={s.headAvatars}>
            <Avatar who="leo" size={30} />
            <Avatar who="atlas" size={38} />
            <Avatar who="priya" size={30} />
          </div>
          <div className={s.groupName}>fall break 🌊</div>
        </div>
        <div className={s.thread}>
          <Row who="maya" i={0}>
            <p className={s.bubble}>atlas give us some options</p>
          </Row>
          <Row who="atlas" i={1}>
            <p className={s.bubble}>
              three options for nov 12–16, per person (estimates):
              <br />
              1. Charleston · ~$520 · beach + big food scene
              <br />
              2. Savannah · ~$555 · walkable, veg friendly
              <br />
              3. Wilmington · ~$470 · beach, short drive
            </p>
          </Row>
          <Row who="atlas" i={2} name={false}>
            <div className={s.poll}>
              <div className={s.pollTitle}>where are we going? 🗳️</div>
              {POLL.map((o) => (
                <div key={o.label} className={s.pollOption}>
                  <span className={`${s.pollCheck} ${o.votes.includes("maya") ? s.pollChecked : ""}`} />
                  <span className={s.pollLabel}>{o.label}</span>
                  <span className={s.pollVotes}>
                    {o.votes.map((v) => (
                      <Avatar key={v} who={v} size={18} />
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </Row>
          <Row who="atlas" i={3} name={false}>
            <p className={s.bubble}>🎉 charleston it is! 2 of 3 votes. locked in for nov 12–16</p>
          </Row>
          <Row who="leo" i={4}>
            <p className={s.bubble}>
              LETS GOOO 🌊<span className={s.tapback}>❤️</span>
            </p>
          </Row>
        </div>
        <div className={s.inputBar}>
          <span className={s.plus}>+</span>
          <span className={s.field}>iMessage</span>
        </div>
      </div>
    </div>
  );
}

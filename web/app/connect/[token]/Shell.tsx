// Frame for the consent screen: a full-viewport light surface with the bank's top bar,
// independent of the trip pages' plain styling.
import s from "./connect.module.css";

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className={s.shell}>
      <header className={s.bar}>
        <span className={s.wordmark}>Capital One</span>
        <span className={s.secure}>
          <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true">
            <path d="M3 6V4a3 3 0 0 1 6 0v2h.5A1.5 1.5 0 0 1 11 7.5v5A1.5 1.5 0 0 1 9.5 14h-7A1.5 1.5 0 0 1 1 12.5v-5A1.5 1.5 0 0 1 2.5 6H3Zm1.5 0h3V4a1.5 1.5 0 0 0-3 0v2Z" fill="currentColor" />
          </svg>
          Secure connection
        </span>
      </header>
      <div className={s.body}>{children}</div>
    </div>
  );
}

export function Notice({ tone, title, body, action }: { tone: "ok" | "warn"; title: string; body: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className={s.card} role={tone === "warn" ? "alert" : "status"}>
      <div className={tone === "ok" ? s.markOk : s.markWarn} aria-hidden="true">
        {tone === "ok" ? "✓" : "!"}
      </div>
      <h1 className={s.title}>{title}</h1>
      <p className={s.noticeBody}>{body}</p>
      {action}
    </section>
  );
}

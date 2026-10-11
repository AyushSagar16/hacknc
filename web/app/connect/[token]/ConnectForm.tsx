"use client";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { connectAction, type ConnectState } from "./actions";
import { Notice } from "./Shell";
import s from "./connect.module.css";

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={s.primary} disabled={pending} aria-busy={pending}>
      {pending ? <span className={s.spinner} aria-label="Connecting" /> : label}
    </button>
  );
}

export function ConnectForm({ token, name }: { token: string; name: string }) {
  const [state, action] = useActionState<ConnectState, FormData>(connectAction, { status: "idle" });

  if (state.status === "connected") {
    return (
      <div className={s.overlay}>
        <Notice tone="ok" title={`You’re connected, ${state.name}`} body="Head back to your group chat. Atlas will plan around your budget and keep it private." />
      </div>
    );
  }
  if (state.status === "expired" || state.status === "invalid") {
    return (
      <div className={s.overlay}>
        <Notice
          tone="warn"
          title={state.status === "expired" ? "This link has expired" : "This link doesn’t work"}
          body={
            <>
              Ask Atlas for a new one: say <strong>“connect me”</strong> in your group chat.
            </>
          }
        />
      </div>
    );
  }

  return (
    <form action={action} className={s.form}>
      <input type="hidden" name="token" value={token} />
      {state.status === "unreachable" ? (
        <p className={s.error} role="alert">
          We couldn’t reach Atlas just now. Nothing was shared. Try again in a minute.
        </p>
      ) : null}
      <Submit label={state.status === "unreachable" ? "Try again" : `Connect as ${name}`} />
    </form>
  );
}

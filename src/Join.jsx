// The page an invitation opens: /invite#<token>. Who asked, as what, who is
// there, and the email address to verify. It is a page of its own rather than
// the workspace, because the person opening it usually has no workspace yet: it
// loads no state, no live connection and no theme, and it wears the look of
// /login and /enter, which it sits between. Somebody who already has an
// account signs in first and comes back here to join with one press, and
// somebody else signed in on this browser is told so before anything else.
import React, { useEffect, useRef, useState } from "react";
import { User, Users, Mail, ArrowRight } from "lucide-react";
import { api, Avatar } from "./ui.jsx";
import CompanyTile from "./CompanyTile.jsx";
import { forgetDrafts } from "./drafts.mjs";
import { forgetCompanies } from "./known-companies.mjs";
import { roleCard, whoIsThere, INCOMPLETE } from "./join-words.mjs";
import "./join.css";

// After the #, so it never reaches a server in a URL.
const currentToken = () => window.location.hash.slice(1);
// No answer at all. The browser's own words for that are "Failed to fetch".
const NO_ANSWER = "TameDuck did not answer. Check your internet and try again.";
const said = (e) => (e.status ? e.message : NO_ANSWER);

export default function Join() {
  // null while asking; then { invitation, you }, { dead } or { failed }.
  const [look, setLook] = useState(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(currentToken);
  const heading = useRef(null);
  const headingNext = useRef(false);

  async function ask(isLive = () => true) {
    try {
      const r = await api("/auth/invitation", "POST", { token });
      // Already in that company: straight there.
      if (!isLive()) return;
      if (r.joined) return window.location.replace("/w/" + r.joined);
      // Nobody is signed in here, or nobody any more. The names of the last
      // person's companies, kept so the page that opens TameDuck can name
      // one, are not for whoever holds this link, as on every page of the
      // way in (public/auth.js).
      if (!r.you) forgetCompanies();
      setLook(r);
    } catch (e) {
      if (!isLive()) return;
      if (e.status === 410) setLook({ dead: e.message });
      else if (e.status === 400) setLook({ dead: INCOMPLETE });
      else setLook({ failed: said(e) });
    }
  }
  useEffect(() => {
    const changed = () => {
      setToken(currentToken());
      setLook(null);
      setProblem("");
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    let live = true;
    if (!token) setLook({ dead: INCOMPLETE });
    else ask(() => live);
    return () => {
      live = false;
    };
  }, [token]);

  const invitation = look?.invitation;
  const you = look?.you;
  const company = invitation?.company.name;
  const state = !look
    ? "asking"
    : look.dead
      ? "dead"
      : look.failed
        ? "failed"
        : you
          ? you.email === invitation.email
            ? "signed-in"
            : "somebody-else"
          : invitation.account
            ? "has-account"
            : "new";

  useEffect(() => {
    document.title = invitation
      ? `Join ${company} · TameDuck`
      : "Invitation · TameDuck";
    if (headingNext.current && heading.current) {
      headingNext.current = false;
      heading.current.focus();
    }
  }, [look]);

  async function join(e) {
    e.preventDefault();
    if (busy) return;
    setProblem("");
    setBusy(true);
    try {
      await api("/invites/accept", "POST", { token });
      window.location.replace("/");
    } catch (e) {
      setBusy(false);
      // Taken in another tab, sent again or revoked since this page opened:
      // ask again, and say what it is now.
      if (e.status === 410) return ask();
      setProblem(said(e));
    }
  }

  async function signOut() {
    setProblem("");
    setBusy(true);
    try {
      // Unsent words go with the person, as Settings' Sign out does. Their
      // companies go when the page asks again, and nobody is signed in.
      forgetDrafts(you.id);
      await api("/auth/logout", "POST", {});
      headingNext.current = true;
      await ask();
    } catch (e) {
      setProblem(said(e));
    }
    setBusy(false);
  }

  const problemLine = problem && (
    <p className="join-problem" role="alert">
      {problem}
    </p>
  );
  const asked = invitation && (
    <div className="join-asked">
      <CompanyTile company={invitation.company} className="join-tile" />
      <span className="join-by">
        <Avatar name={invitation.invited_by} size={24} />
        <span>
          <strong>{invitation.invited_by}</strong> invited you
        </span>
      </span>
    </div>
  );
  const card = invitation && (
    <div className="join-card">
      <div className="join-row">
        <span className="join-icon join-role" aria-hidden="true">
          <User size={16} />
        </span>
        <span className="join-words">
          <strong>{roleCard(invitation.role).title}</strong>
          <span>{roleCard(invitation.role).line}</span>
        </span>
      </div>
      <div className="join-row join-there">
        <span className="join-icon join-team" aria-hidden="true">
          <Users size={16} />
        </span>
        <span className="join-words">
          <strong>Who is there</strong>
          <span>{whoIsThere(invitation)}</span>
        </span>
        <span className="join-faces" aria-hidden="true">
          {invitation.people.map((p, i) => (
            <Avatar key={"p" + i} name={p} size={26} />
          ))}
          {invitation.ducks.map((d, i) => (
            <Avatar key={"d" + i} duck={d} size={26} />
          ))}
        </span>
      </div>
    </div>
  );
  const title = (
    <h1 ref={heading} tabIndex={-1}>
      Join {company}
    </h1>
  );
  const joinButton = (
    <button type="submit" className="join-go" disabled={busy}>
      {busy ? (
        "Joining…"
      ) : (
        <>
          Join {company} <ArrowRight size={17} />
        </>
      )}
    </button>
  );

  let body;
  if (state === "asking")
    body = (
      <p className="join-wait" aria-live="polite">
        Opening your invitation…
      </p>
    );
  else if (state === "dead" || state === "failed")
    body = (
      <>
        <h1 ref={heading} tabIndex={-1}>
          {state === "dead"
            ? "This invitation does not work"
            : "That did not work"}
        </h1>
        <p className="join-why">{look.dead || look.failed}</p>
        {state === "dead" ? (
          <a className="join-ghost" href="/login">
            Go to sign in
          </a>
        ) : (
          <button
            type="button"
            className="join-ghost"
            onClick={() => {
              setLook(null);
              ask();
            }}
          >
            Try again
          </button>
        )}
      </>
    );
  else if (state === "somebody-else")
    body = (
      <>
        <div className="join-asked join-small">
          <CompanyTile company={invitation.company} className="join-tile" />
          {title}
        </div>
        <div className="join-other">
          <span className="join-other-icon" aria-hidden="true">
            <User size={15} />
          </span>
          <span className="join-words">
            <strong>This invitation is for {invitation.email}</strong>
            <span>
              You are signed in here as {you.name}. Sign out first, so they can
              join.
            </span>
          </span>
        </div>
        <div className="join-acts">
          <button
            type="button"
            className="join-go"
            disabled={busy}
            onClick={signOut}
          >
            {busy ? "Signing out…" : "Sign out and continue"}
          </button>
          <a className="join-ghost" href="/">
            Stay as {you.first}
          </a>
        </div>
        {problemLine}
      </>
    );
  else if (state === "has-account" || state === "new")
    body = (
      <>
        {asked}
        {title}
        {card}
        <div className="join-form">
          <p className="join-as">
            <Mail size={14} />{" "}
            {state === "new"
              ? `Verify your email address ${invitation.email}.`
              : `You already use TameDuck as ${invitation.email}.`}
          </p>
          <div className="join-send">
            <a
              className="join-go"
              href={"/login#next=" + encodeURIComponent("/invite#" + token)}
            >
              {state === "new" ? "Verify email to join" : "Sign in to join"}{" "}
              <ArrowRight size={17} />
            </a>
            <p className="join-note">
              Signing in emails you a link. It brings you back here to join.
            </p>
            <p className="join-consent">
              By joining, you agree to the <a href="/terms">Terms</a> and{" "}
              <a href="/privacy">Privacy policy</a>.
            </p>
          </div>
        </div>
      </>
    );
  else
    body = (
      <>
        {asked}
        {title}
        {card}
        <form className="join-form" onSubmit={join} noValidate>
          <div className="join-field">
            <p className="join-as">
              <User size={14} /> Signed in as {you.name} · {you.email}
            </p>
          </div>
          <div className="join-send">
            {joinButton}
            <p className="join-consent">
              By joining, you agree to the <a href="/terms">Terms</a> and{" "}
              <a href="/privacy">Privacy policy</a>.
            </p>
            {problemLine}
          </div>
        </form>
      </>
    );

  // Where the person holding the page may not be the one invited.
  const footer = ["new", "has-account", "somebody-else"].includes(state);
  return (
    <div className="join-page">
      <header className="join-gut join-head">
        <a className="join-brand" href="/">
          <img src="/brand/mark.svg" width="32" height="32" alt="" />
          <b>TameDuck</b>
        </a>
      </header>
      <main className="join-gut join-main">
        <div
          className={
            "join-col" +
            (state === "dead" || state === "failed" ? " join-plain" : "")
          }
        >
          {body}
        </div>
      </main>
      {footer && (
        <footer className="join-gut">
          <div className="join-foot">
            <span>
              Not {invitation.email}? Close this page and nothing happens.
            </span>
            <span className="join-legal">
              <a href="/privacy">Privacy</a>
              <a href="/terms">Terms</a>
            </span>
          </div>
        </footer>
      )}
    </div>
  );
}

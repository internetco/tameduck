// The three pages of the way in. One file, because they share every behaviour
// worth having: ask for a link, say a link is coming, and spend one.
//
// Separate from the workspace bundle on purpose - somebody who has not got in
// yet should download a form, not an application - and a separate file rather
// than an inline script because the app's Content-Security-Policy is
// script-src 'self', which drops inline handlers without a word.
(function () {
  "use strict";

  // Whoever comes in here is signed out, or about to come in as somebody
  // else. The names of the last person's companies, kept so the page that
  // opens TameDuck can name one (src/known-companies.mjs), are not theirs to
  // see: a session that simply ran out never told the app to forget them.
  try {
    localStorage.removeItem("tameduck:companies");
  } catch (e) {}

  // The page somebody was opening when they were asked to sign in: an app
  // link, or an invitation. The same rule as localPath in server/sign-in.mjs.
  function localPath(value) {
    if (typeof value !== "string" || value.length > 2000) return null;
    if (!/^\/(?![/\\])/.test(value)) return null;
    if (/[\s\u0000-\u001f\u007f]/.test(value)) return null;
    if (/^\/(login|enter|start)/.test(value)) return null;
    return value;
  }
  // After the #, like the link's own token: /login#next=... and
  // /enter#<token>&next=... A token is base64url, so it never holds & or =.
  var next = null;
  var carried = /(?:^#|&)next=([^&]*)/.exec(window.location.hash);
  if (carried) {
    try {
      next = localPath(decodeURIComponent(carried[1]));
    } catch (e) {}
  }

  // The browser completes the normal email and two-step sign-in before it
  // can issue the one-time code that the person enters in the desktop app.
  if (next && /^\/desktop-signin#request=[A-Za-z0-9_-]{43}$/.test(next)) {
    var desktopNotice = document.createElement("p");
    desktopNotice.className = "bubble duck";
    desktopNotice.textContent =
      "After signing in here, get a one-time code to enter in the TameDuck desktop app.";
    var desktopHost =
      document.querySelector(".chat") || document.querySelector("main");
    if (desktopHost)
      desktopHost.insertBefore(desktopNotice, desktopHost.firstChild);
  }

  function post(path, body) {
    return fetch("/api" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TameDuck": "1" },
      body: JSON.stringify(body),
    }).then(
      function (r) {
        return r
          .json()
          .catch(function () {
            return { error: "TameDuck did not answer. Try again in a minute." };
          })
          .then(function (data) {
            if (!r.ok)
              throw Object.assign(
                new Error(data.error || "Something went wrong."),
                {
                  status: r.status,
                },
              );
            return data;
          });
      },
      // No answer at all. The browser's own words for that are "Failed to
      // fetch", which Chief Duck would then say to somebody's face.
      function () {
        throw Object.assign(
          new Error(
            "I can't reach TameDuck right now. Check your internet and try again.",
          ),
          { status: 0 },
        );
      },
    );
  }

  var problem = document.getElementById("problem");
  function say(message) {
    if (!problem) return;
    problem.textContent = message;
    problem.classList.remove("hide");
  }
  function quiet() {
    if (problem) problem.classList.add("hide");
  }

  // ---- asking for a link -------------------------------------------------
  var form = document.getElementById("form");
  if (form) {
    var done = document.getElementById("done");
    var input = document.getElementById("email");
    var send = document.getElementById("send");
    var sentTo = document.getElementById("sent-to");
    var answer = document.getElementById("answer");
    var said = document.getElementById("said");
    var after = document.getElementById("after");
    var afterFirst = after && after.textContent;
    var where = document.getElementById("where");
    var wait = document.getElementById("wait");
    var again = document.getElementById("again");
    var change = document.getElementById("change");
    var ticking = null;
    var NOT_AN_ADDRESS =
      "That doesn't look like an email address. Check it and send it again.";

    // The link signs in whatever opens it, so where to open it is the whole
    // sentence. A finger on the glass means a phone or a tablet, whichever
    // way up it is held; the shorter side of the screen tells which.
    if (window.matchMedia && window.matchMedia("(pointer: coarse)").matches)
      where.textContent =
        Math.min(screen.width, screen.height) < 600
          ? "on this phone"
          : "on this tablet";

    // Another link is worth offering, but not straight away: a second one a
    // second later is somebody who has not looked yet, and every extra link is
    // another live key sitting in a mailbox. The wait is part of the button's
    // own words, so it cannot be read as belonging to the button beside it.
    function countdown(seconds) {
      again.disabled = true;
      clearInterval(ticking);
      ticking = setInterval(function () {
        seconds -= 1;
        if (seconds <= 0) {
          clearInterval(ticking);
          again.disabled = false;
          wait.textContent = "";
          return;
        }
        wait.textContent =
          "in 0:" + (seconds < 10 ? "0" : "") + String(seconds);
      }, 1000);
      wait.textContent = "in 0:" + (seconds < 10 ? "0" : "") + String(seconds);
    }

    function request(address, repeat) {
      quiet();
      if (repeat) again.disabled = true;
      else {
        send.disabled = true;
        send.textContent = "Sending…";
        input.readOnly = true;
      }
      return post("/auth/link", { email: address, next: next || undefined })
        .then(function () {
          sentTo.textContent = address;
          said.textContent = repeat ? "Sent again." : "Sent.";
          // The server sends at most three links a quarter of an hour to one
          // address and answers the same either way, so that nobody can use
          // this box to learn about somebody else. A fourth "Sent" would be a
          // promise it did not keep; the newest link that did come still works.
          if (after && repeat)
            after.textContent =
              "Nothing new after a few tries? I send three links every 15 minutes at most. Use the newest one you have, or look in spam.";
          form.classList.add("hide");
          done.classList.remove("hide");
          countdown(45);
          // The button that was pressed has just gone, and focus would fall
          // to the top of the page. The answer is what to read next.
          answer.focus();
        })
        .catch(function (e) {
          if (repeat) again.disabled = false;
          // The browser lets through addresses the server will not, like
          // x@y, and the server's own words for that are not Chief Duck's.
          say(e.status === 400 ? NOT_AN_ADDRESS : e.message);
        })
        .then(function () {
          send.disabled = false;
          send.textContent = "Send";
          input.readOnly = false;
        });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (send.disabled) return;
      var address = (input.value || "").trim();
      // The browser's own check, asked for rather than relied on: novalidate
      // is set so the message lands in the chat instead of a native bubble
      // that a screen reader never announces.
      if (!address) return say("Type your email, then press Send.");
      if (!input.checkValidity()) return say(NOT_AN_ADDRESS);
      request(address, false);
    });

    again.addEventListener("click", function () {
      request((input.value || "").trim(), true);
    });

    change.addEventListener("click", function () {
      clearInterval(ticking);
      done.classList.add("hide");
      form.classList.remove("hide");
      if (after) after.textContent = afterFirst;
      quiet();
      input.focus();
      input.select();
    });
  }

  // ---- spending one ------------------------------------------------------
  var head = document.getElementById("enter-head");
  if (head) {
    var sub = document.getElementById("enter-sub");
    var retry = document.getElementById("enter-again");
    // Something went wrong with the link, so Chief Duck asks for the address
    // again right here: a new link is the only way forward, and sending
    // somebody off to another page to ask for it was one step too many.
    var askAgain = function () {
      retry.classList.remove("hide");
      form.classList.remove("hide");
    };
    // After the # and nowhere else. A fragment is never sent to a server, so
    // this token is in no access log and no referrer; it exists in this tab
    // and in the mailbox it arrived in.
    var value = window.location.hash.slice(1).split("&next=")[0];
    // Taken out of the address bar before anything else, so it does not sit in
    // history or get shared when somebody copies the URL to ask for help.
    if (value) history.replaceState(null, "", window.location.pathname);

    var incomplete = function () {
      head.textContent = "That link is not complete.";
      sub.textContent =
        "The whole link has to arrive in one piece. Some mail apps cut the end off.";
    };

    // ---- the second step, for somebody with two-step sign-in on ----------
    var enterSay = document.getElementById("enter-say");
    var codeStep = document.getElementById("code-step");
    var codeAsk = document.getElementById("code-ask");
    var codeForm = document.getElementById("code-form");
    var codeInput = document.getElementById("code");
    var codeLabel = document.getElementById("code-label");
    var codeSend = document.getElementById("code-send");
    var codeSwitch = document.getElementById("code-switch");
    var codeLost = document.getElementById("code-lost");
    var codeLostSay = document.getElementById("code-lost-say");
    var noPassword = document.getElementById("fact-no-password");
    var backup = false;
    var ASK_APP =
      "One more step: type the 6-digit code from your authenticator app.";
    var ASK_BACKUP = "Type one of your backup codes. Each one works once.";

    // "No password" is beside the point under a code step.
    var codeOwed = function () {
      if (noPassword) noPassword.classList.add("hide");
    };
    var askForCode = function () {
      codeOwed();
      enterSay.classList.add("hide");
      codeStep.classList.remove("hide");
      codeInput.focus();
    };
    // The pending sign-in is over - run out, or five wrong codes in it. The
    // only way on is a fresh start, so Chief Duck says why and asks for the
    // address to send a new link to. The button that was pressed has gone,
    // so the box to type into is where the keyboard goes.
    var stopped = function (message) {
      quiet();
      codeStep.classList.add("hide");
      enterSay.classList.remove("hide");
      head.textContent = message;
      sub.classList.add("hide");
      askAgain();
      document.getElementById("email").focus();
    };
    // Too many wrong codes for this person, across sign-ins: a new link would
    // only be spent and refused, so none is offered. Chief Duck says how long
    // to wait, and the keyboard goes to what was said.
    var lockedOut = function (message) {
      quiet();
      codeOwed();
      codeStep.classList.add("hide");
      enterSay.classList.remove("hide");
      head.textContent = message;
      sub.textContent = "Then sign in again the way you did just now.";
      sub.classList.remove("hide");
      document.getElementById("locked-acts").classList.remove("hide");
      enterSay.focus();
    };

    codeLost.addEventListener("click", function () {
      codeLostSay.classList.remove("hide");
      codeLost.setAttribute("aria-expanded", "true");
      codeLostSay.focus();
    });

    codeSwitch.addEventListener("click", function () {
      backup = !backup;
      quiet();
      codeAsk.textContent = backup ? ASK_BACKUP : ASK_APP;
      codeLabel.textContent = backup ? "Backup code" : "6-digit code";
      codeSwitch.textContent = backup
        ? "Use the code from the app instead"
        : "Use a backup code instead";
      codeInput.value = "";
      codeInput.setAttribute("inputmode", backup ? "text" : "numeric");
      codeInput.setAttribute("autocomplete", backup ? "off" : "one-time-code");
      codeInput.setAttribute("maxlength", backup ? "20" : "7");
      codeInput.setAttribute("placeholder", backup ? "abcde-fghij" : "123456");
      codeInput.focus();
    });

    codeForm.addEventListener("submit", function (e) {
      e.preventDefault();
      if (codeSend.disabled) return;
      var typed = (codeInput.value || "").trim();
      if (!typed)
        return say(
          backup
            ? "Type one of your backup codes, then press Sign in."
            : "Type the 6-digit code from your app, then press Sign in.",
        );
      if (!backup && !/^[0-9]{6}$/.test(typed.replace(/\s/g, "")))
        return say("The code is 6 digits. Type the newest one from your app.");
      quiet();
      codeSend.disabled = true;
      codeSend.textContent = "Checking…";
      post("/auth/code", backup ? { backup: typed } : { code: typed })
        .then(function () {
          // The page they were opening, or the workspace.
          window.location.replace(next || "/");
        })
        .catch(function (e) {
          codeSend.disabled = false;
          codeSend.textContent = "Sign in";
          // 410 and 429 end this sign-in, 423 locks the person out for a
          // while; anything else is one wrong try.
          if (e.status === 423) return lockedOut(e.message);
          if (e.status === 410 || e.status === 429) return stopped(e.message);
          say(e.message);
          codeInput.select();
        });
    });

    if (!value) {
      // No link, but maybe a code still owed: this page was reloaded after
      // it took the link out of the address. The answer is in an HttpOnly
      // cookie this page cannot read, so it asks.
      fetch("/api/auth/pending", { headers: { "X-TameDuck": "1" } })
        .then(function (r) {
          return r.json();
        })
        .then(function (d) {
          if (d && d.locked) return lockedOut(d.locked);
          if (d && d.waiting) return askForCode();
          incomplete();
          askAgain();
        })
        .catch(function () {
          incomplete();
          askAgain();
        });
    } else {
      post("/auth/enter", { token: value })
        .then(function (r) {
          // The link worked, and two-step sign-in is on: the code comes next.
          if (r && r.code) return r.locked ? lockedOut(r.locked) : askForCode();
          // Replace rather than assign: pressing Back should not land on a
          // page whose only job was to spend a token that is now gone. The
          // page they were opening, or the workspace.
          window.location.replace(next || "/");
        })
        .catch(function (e) {
          // A spent link needs no more words than that: the next bubble
          // already asks for the address to send a new one to.
          if (e.status === 410) {
            head.textContent = "That link has been used, or it ran out.";
            sub.classList.add("hide");
          } else if (e.status === 400) {
            // Too short to be a link at all, so most of it was lost on the
            // way. The server's reason is about string lengths, which means
            // nothing to the person holding the stub.
            incomplete();
          } else {
            head.textContent = "That did not work.";
            sub.textContent = e.message;
          }
          askAgain();
        });
    }
  }
})();

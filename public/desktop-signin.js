(function () {
  "use strict";
  var match = /^#request=([A-Za-z0-9_-]{43})$/.exec(window.location.hash);
  var id = match && match[1];
  var codePattern = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
  var $ = function (name) {
    return document.getElementById(name);
  };
  function fail(message) {
    $("problem").textContent = message;
    $("problem").classList.remove("hide");
  }
  function post(path, body) {
    return fetch("/api/desktop-signin/" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TameDuck": "1" },
      body: JSON.stringify(body),
    }).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (data) {
          if (!response.ok)
            throw new Error(
              data.error || "This sign-in request is no longer available.",
            );
          return data;
        });
    });
  }
  if (!id) {
    $("message").textContent = "This sign-in request is incomplete.";
    return;
  }
  post("info", { id: id })
    .then(function (data) {
      if (!Number.isFinite(data.expires_at) || data.expires_at <= Date.now())
        throw new Error("This sign-in request has expired.");
      if (data.user) {
        $("message").textContent = data.code_issued
          ? "An app sign-in code was already requested. Start a new request in your desktop app if you did not copy it."
          : "Your TameDuck account is ready. Request a one-time code when you are ready to finish signing in on your computer.";
        $("user").textContent =
          (data.user.name || "") +
          (data.user.email ? " · " + data.user.email : "");
        $("user").classList.remove("hide");
        $("approve").disabled = !!data.code_issued;
        if (!data.code_issued)
          $("approve").onclick = function () {
            $("approve").disabled = true;
            post("approve", { id: id })
              .then(function (result) {
                if (
                  !codePattern.test(result.code || "") ||
                  !Number.isFinite(result.expires_at) ||
                  result.expires_at <= Date.now()
                )
                  throw new Error(
                    "The app sign-in code was invalid or expired.",
                  );
                $("code").textContent = result.code;
                $("code").classList.remove("hide");
                $("code-instructions").textContent =
                  "Enter this code in the TameDuck app. It works once and is valid for up to five minutes. Keep it private; this is not your authenticator code.";
                $("message").textContent = "Your app sign-in code is ready.";
              })
              .catch(function (error) {
                $("approve").disabled = false;
                fail(error.message);
              });
          };
      } else {
        $("message").textContent =
          "Sign in to TameDuck first, then return here to get your app code.";
        $("approve").disabled = true;
        var login = document.createElement("a");
        login.href =
          "/login#next=" + encodeURIComponent("/desktop-signin#request=" + id);
        login.textContent = "Sign in with email";
        $("account").insertBefore(login, $("account").firstChild);
      }
      $("account").classList.remove("hide");
    })
    .catch(function (error) {
      $("message").textContent = "We could not prepare this sign-in.";
      fail(error.message);
    });
})();

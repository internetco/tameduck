import React, { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { api, Button } from "./ui.jsx";
import SettingsHead from "./SettingsHead.jsx";
import "./browser-notifications.css";

function applicationKey(value) {
  const bytes = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}

export default function BrowserNotifications({ company }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [permission, setPermission] = useState(window.Notification?.permission);
  const electron = /Electron/i.test(navigator.userAgent);
  const supported =
    window.isSecureContext &&
    !!window.Notification &&
    !!navigator.serviceWorker &&
    !!window.PushManager;

  useEffect(() => {
    let live = true;
    setStatus(null);
    setMessage("");
    if (!electron && supported) {
      (async () => {
        try {
          const value = await api("/notifications/status");
          let subscribed = false;
          if (value.available) {
            const registration =
              await navigator.serviceWorker.getRegistration("/");
            const subscription =
              await registration?.pushManager.getSubscription();
            if (subscription)
              subscribed = !!(
                await api("/notifications/status", "POST", {
                  endpoint: subscription.endpoint,
                  company_id: company.id,
                })
              ).subscribed;
          }
          if (live) setStatus({ ...value, subscribed });
        } catch {
          if (live) setStatus({ available: false });
        }
      })();
    }
    const updatePermission = () =>
      setPermission(window.Notification?.permission);
    window.addEventListener("focus", updatePermission);
    return () => {
      live = false;
      window.removeEventListener("focus", updatePermission);
    };
  }, [company?.id, electron, supported]);

  const enable = async () => {
    setBusy(true);
    setMessage("");
    try {
      // Browsers require the permission request to follow this explicit click.
      const answer = await Notification.requestPermission();
      setPermission(answer);
      if (answer !== "granted") {
        setMessage(
          answer === "denied"
            ? "Notifications are blocked. Allow them in this site's browser settings to try again."
            : "Notifications are still off.",
        );
        return;
      }
      await navigator.serviceWorker.register("/notifications-sw.js", {
        scope: "/",
        updateViaCache: "none",
      });
      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription)
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: applicationKey(status.publicKey),
        });
      await api("/notifications/subscribe", "POST", {
        subscription: subscription.toJSON(),
        company_id: company.id,
      });
      setStatus((value) => ({ ...value, subscribed: true }));
      setMessage("Notifications are on for this company in this browser.");
    } catch {
      setMessage("Could not enable notifications. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setMessage("");
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription)
        await api("/notifications/unsubscribe", "POST", {
          endpoint: subscription.endpoint,
          company_id: company.id,
        });
      // Other company subscriptions may share this browser endpoint.
      setStatus((value) => ({ ...value, subscribed: false }));
      setMessage("Notifications are off for this company in this browser.");
    } catch {
      setMessage("Could not turn notifications off. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-page browser-notifications">
      <SettingsHead page="notifications" />
      <div className="browser-notification-card">
        <Bell size={24} aria-hidden="true" />
        <div>
          <h3>
            {electron ? "Desktop notifications" : "Browser notifications"}
          </h3>
          <p>
            {electron
              ? "The TameDuck app handles Duck notifications. You can pause them from the app menu."
              : `Get an alert when a Duck replies or needs your attention in ${company?.name || "this company"}, even after you close the tab.`}
          </p>
          {!electron && (
            <p className="notification-help">
              Alerts keep message contents private. Delivery depends on your
              browser and device notification settings. Signing out stops alerts
              for this session.
            </p>
          )}
          {!electron && !supported && (
            <p>
              This browser does not support background notifications. You can
              use the desktop app instead.
            </p>
          )}
          {!electron && supported && !status && (
            <p role="status">Checking notification settings…</p>
          )}
          {!electron && supported && status?.available === false && (
            <p>
              Notifications are temporarily unavailable. Please try again later.
            </p>
          )}
          {!electron && supported && permission === "denied" && (
            <p>
              Notifications are blocked. Allow them in this site's browser
              settings to receive alerts.
            </p>
          )}
          {!electron && supported && status?.available && (
            <Button
              disabled={
                busy ||
                (!status.subscribed &&
                  (permission === "denied" || !status.publicKey))
              }
              onClick={status.subscribed ? disable : enable}
            >
              {busy
                ? "Saving…"
                : status.subscribed
                  ? "Turn off notifications"
                  : "Enable notifications"}
            </Button>
          )}
          {message && <p role="status">{message}</p>}
        </div>
      </div>
    </section>
  );
}

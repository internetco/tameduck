import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import Join from "./Join.jsx";
import "./style.css";
import "./board-display.css";
import "./themes.css";
import { initialTheme } from "./Appearance.jsx";
import { startPresence } from "./presence.mjs";
// An invitation is a page of its own, like the way in: the person opening it
// usually has no workspace yet. It keeps the sign-in pages' look whatever
// theme this browser saved, so it does not wear one, not even the one
// public/theme.js put on before this script arrived.
const joining = window.location.pathname === "/invite";
if (window.location.pathname === "/setup" && window.location.hash.length > 1)
  window.tameduckAnalytics?.pageView("/setup");
if (joining) {
  window.tameduckAnalytics?.pageView("/invite");
  document.documentElement.classList.add("joining");
  delete document.documentElement.dataset.theme;
} else document.documentElement.dataset.theme = initialTheme();
createRoot(document.getElementById("root")).render(
  joining ? <Join /> : <App />,
);
startPresence();

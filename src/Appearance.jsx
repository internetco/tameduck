import React, { useState } from "react";
import { Check } from "lucide-react";
import SettingsHead from "./SettingsHead.jsx";
export const themes = [
  {
    id: "electric",
    name: "Electric",
    description: "Bright, bold, full of energy. Default.",
    rail: "#24165b",
    sidebar: "#40258d",
    main: "#ffffff",
    accent: "#3866f7",
    text: "#dacefa",
  },
  {
    id: "clean",
    name: "Clean",
    description: "Crisp white, clear blue, no distractions.",
    rail: "#152b47",
    sidebar: "#f7f9fc",
    main: "#ffffff",
    accent: "#2264d8",
    text: "#465972",
  },
  {
    id: "dark",
    name: "Dark",
    description: "Deep charcoal with bright, readable accents.",
    rail: "#14131e",
    sidebar: "#201e2e",
    main: "#262435",
    accent: "#725cf4",
    text: "#d5cfee",
  },
  {
    id: "subtle",
    name: "Subtle",
    description: "A quieter take on the purple workspace.",
    rail: "#3b354e",
    sidebar: "#eeeaf4",
    main: "#ffffff",
    accent: "#76658e",
    text: "#665775",
  },
  {
    id: "calm",
    name: "Calm",
    description: "The original sage and forest palette.",
    rail: "#183f34",
    sidebar: "#edf3ed",
    main: "#ffffff",
    accent: "#39705a",
    text: "#516458",
  },
];
export function setTheme(id) {
  if (!themes.some((t) => t.id === id)) id = "electric";
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem("tameduck-theme", id);
  } catch {}
  window.dispatchEvent(new Event("tameduck-theme"));
}
export function initialTheme() {
  try {
    const id = localStorage.getItem("tameduck-theme");
    return themes.some((t) => t.id === id) ? id : "electric";
  } catch {
    return "electric";
  }
}
export default function Appearance() {
  const [selected, select] = useState(initialTheme());
  return (
    <>
      <SettingsHead page="appearance" />
      <div className="theme-options">
        {themes.map((t) => (
          <button
            key={t.id}
            className={"theme-option " + (selected === t.id ? "selected" : "")}
            aria-pressed={selected === t.id}
            onClick={() => {
              setTheme(t.id);
              select(t.id);
            }}
          >
            <div className="theme-preview" aria-hidden="true">
              <span className="preview-top" style={{ background: t.rail }} />
              <span
                className="preview-sidebar"
                style={{ background: t.sidebar, color: t.text }}
              >
                <i style={{ background: t.accent }} />
                <i />
                <i />
                <i />
              </span>
              <span
                className="preview-main"
                style={{
                  background: t.main,
                  color: t.id === "dark" ? "#eee" : t.rail,
                }}
              >
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>
            <strong>
              {t.name}
              {selected === t.id && <Check size={16} />}
            </strong>
            <small>{t.description}</small>
          </button>
        ))}
      </div>
      <p className="appearance-note">
        All themes use the same layout and features. Electric stays the default
        for new browsers.
      </p>
    </>
  );
}

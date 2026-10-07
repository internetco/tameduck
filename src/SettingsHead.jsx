import React from "react";
import { settingsPage } from "./settings-pages.mjs";

// The top of every settings page: its name from the menu, and one line on what
// it is for. Titles used to be slogans in three sizes ("Secrets, together.",
// "Bring your favorite tools." at 30px) with a hidden eyebrow above each.
//
// The title can take the keyboard, so a person who picks a page on a phone,
// where the menu is put away, is left on the page they picked.
export default function SettingsHead({ page, company, children }) {
  const { name, intro } = settingsPage(page);
  return (
    <div className="settings-heading">
      <div>
        <h2 tabIndex={-1}>{name}</h2>
        <p>{intro(company)}</p>
      </div>
      {children && <div className="settings-heading-side">{children}</div>}
    </div>
  );
}

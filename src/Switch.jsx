import React from "react";
import "./duck-permissions.css";

// The switch this product did not have: a real tick box, drawn as a track and a
// knob. The box itself is what the keyboard and a screen reader get, so Tab and
// Space still work and it is still announced as on or off.
//
// Settings > Ducks and a duck's Contacts both draw it, so it lives here rather
// than in either of them.
export function Switch({ checked, disabled, label, describedBy, onChange }) {
  return (
    <span className="duck-perms-switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="duck-perms-track" aria-hidden="true" />
    </span>
  );
}

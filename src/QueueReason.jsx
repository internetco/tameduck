import React from "react";

// Keep the explanation compact until someone asks to read it.
export function QueueReason({ reason, showLabel = true }) {
  if (!reason) return null;
  return (
    <>
      {showLabel && <span className="queue-reason-label">{reason.label}</span>}
      {reason.detail && (
        <details className="queue-reason-details">
          <summary>Why it's waiting</summary>
          <span>{reason.detail}</span>
        </details>
      )}
    </>
  );
}

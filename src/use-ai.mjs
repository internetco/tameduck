import { useEffect, useState } from "react";
import { api } from "./ui.jsx";

// Whether any duck can work right now, asked of the server - the same question
// chat asks before it shows "Ready when you are", so the two screens cannot
// disagree. undefined until the answer arrives, so nothing is greyed out while
// nobody knows yet.
export function useAIReady(companyId) {
  const [ready, setReady] = useState(undefined);
  useEffect(() => {
    let live = true;
    api("/ai/status")
      .then((s) => {
        // Only a plain "no" greys anything out - the same rule the server
        // follows. An answer that does not say, or says it could not ask,
        // leaves every button as it was.
        if (live)
          setReady(
            !(s?.connected === false && !s?.error && !s?.codex?.error),
          );
      })
      .catch(() => {
        if (live) setReady(undefined);
      });
    return () => {
      live = false;
    };
  }, [companyId]);
  return ready;
}

// What to say in its place: whoever can connect one is told to, and everybody
// else who can. Kept beside the rule it follows, where a test can read it.
export { withoutAIWords } from "../shared/ai-access.mjs";

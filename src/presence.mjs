// Telling the server that a person is here.
//
// A reminder email goes to somebody who has had something waiting on them for
// half an hour and has not been in to see it. "Been in" cannot be read off a
// session or a request: the app polls /api/state and keeps an event stream
// open whether anybody is looking or not, so a tab forgotten behind twenty
// others would count as present all day and stop the one email that person
// needed. So the page says so itself, and only when it is true: it is the one
// showing, and somebody has touched it in the last ten minutes.
//
// It says so on the requests the app already makes - api() adds hereHeaders()
// to each, and /api/state alone goes out every 12 seconds - rather than with a
// request of its own. The first version posted to /api/presence at load, and a
// request fired while the app was starting was one Playwright never saw
// finish, so every browser check that waited for "networkidle" hung on it.
const IDLE = 10 * 60 * 1000;

let touched = 0;
let started = false;

// Which company this tab is showing. One cookie serves every tab, and the
// session only knows the company somebody switched to last.
const shownCompany = () =>
  (window.location.pathname.match(/^\/w\/([A-Za-z0-9_-]{1,100})(?:\/|$)/) ||
    [])[1] || null;

export function startPresence() {
  if (
    started ||
    typeof window === "undefined" ||
    typeof document === "undefined"
  )
    return;
  started = true;
  touched = Date.now();
  const touch = () => {
    touched = Date.now();
  };
  for (const kind of [
    "pointerdown",
    "pointermove",
    "keydown",
    "wheel",
    "touchstart",
    "scroll",
  ])
    window.addEventListener(kind, touch, { passive: true, capture: true });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) touch();
  });
}

// What to add to a request: the company on screen, or "1" when the address
// names none, and nothing at all when the page is hidden or nobody has touched
// it in ten minutes.
export function hereHeaders() {
  if (!started || typeof document === "undefined") return {};
  if (document.hidden) return {};
  if (Date.now() - touched > IDLE) return {};
  return { "X-TameDuck-Here": shownCompany() || "1" };
}

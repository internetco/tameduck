// A one-at-a-time queue for live previews. A capture can take longer than the
// next polling tick; cancelling it at every tick means the first frame may
// never arrive. Keep that request, then fetch only the newest queued frame.
export function createScreenshotQueue({ load, onLoad, onError }) {
  let active = false;
  let cancelled = false;
  let pending = null;
  let controller = null;
  const run = () => {
    if (cancelled || active || !pending) return;
    const source = pending;
    pending = null;
    active = true;
    controller = new AbortController();
    const signal = controller.signal;
    Promise.resolve()
      .then(() => load(source, { signal }))
      .then((value) => {
        if (!cancelled) onLoad(value, source);
      })
      .catch((error) => {
        if (!cancelled && error?.name !== "AbortError") onError(error, source);
      })
      .finally(() => {
        active = false;
        controller = null;
        run();
      });
  };
  return {
    schedule(source) {
      if (cancelled) return;
      pending = source;
      run();
    },
    cancel() {
      cancelled = true;
      pending = null;
      controller?.abort();
    },
  };
}

// Embed the fetched bytes using data: images, which the application CSP
// already permits. The visible image cannot make a second network request
// that fails after a successful preload; no object URL needs to stay alive.
export async function fetchScreenshot(
  source,
  {
    signal,
    fetchFn = fetch,
    readUrl = screenshotDataUrl,
    decode = decodeScreenshot,
    timeoutMs = 15000,
  } = {},
) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Screenshot request timed out")),
    timeoutMs,
  );
  try {
    const response = await fetchFn(source, { signal: controller.signal });
    if (!response.ok)
      throw new Error("Screenshot request failed: " + response.status);
    const url = await readUrl(await response.blob());
    await decode(url);
    return url;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

// Fetching a blob only says the server answered. Decode it before handing its
// URL to the visible <img>, so a corrupt successful response cannot surface as
// a broken-image glyph either.
export function decodeScreenshot(source, { ImageCtor = Image } = {}) {
  return new Promise((resolve, reject) => {
    const image = new ImageCtor();
    image.onload = resolve;
    image.onerror = () => reject(new Error("Screenshot could not be decoded"));
    image.src = source;
  });
}

export function screenshotDataUrl(blob, { Reader = FileReader } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new Reader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () =>
      reject(reader.error || new Error("Screenshot could not be read"));
    reader.readAsDataURL(blob);
  });
}

// Only qualified models can be used; each deployment must explicitly enable the connection.
export const openrouterAvailable = (env = process.env) =>
  (env.APP_URL === "https://staging.tameduck.com" &&
    env.OPENROUTER_STAGING_TESTING === "1") ||
  (env.APP_URL === "https://tameduck.com" && env.OPENROUTER_ENABLED === "1");

export const openrouterModelAllowed = (registered, env = process.env) =>
  registered === true && openrouterAvailable(env);

export async function validateOpenRouterKey(key, fetcher = fetch) {
  if (!openrouterAvailable()) {
    throw Object.assign(
      new Error("OpenRouter is unavailable on this server."),
      { status: 409 },
    );
  }
  let response;
  try {
    response = await fetcher("https://openrouter.ai/api/v1/key", {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
        "HTTP-Referer": process.env.APP_URL,
        "X-Title": "TameDuck",
      },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw Object.assign(
      new Error("OpenRouter could not be reached. Please try again."),
      { status: 502 },
    );
  }
  if (!response.ok) {
    throw Object.assign(
      new Error(
        response.status === 401 || response.status === 403
          ? "OpenRouter API key was rejected."
          : "OpenRouter could not validate the key. Please try again.",
      ),
      {
        status: response.status === 401 || response.status === 403 ? 401 : 502,
      },
    );
  }
  let body;
  try {
    body = await response.json();
  } catch {}
  if (
    !body?.data ||
    typeof body.data !== "object" ||
    Array.isArray(body.data) ||
    body.error
  ) {
    throw Object.assign(
      new Error("OpenRouter returned an invalid key validation response."),
      { status: 502 },
    );
  }
  return true;
}

// Resolve SMTP settings without changing passwords that contain URL punctuation.
// SMTP_URL remains available for older staging configurations.
export function mailTransportConfig(env) {
  const host = env.SMTP_HOST?.trim();
  if (host) {
    const rawPort = env.SMTP_PORT === undefined ? "587" : env.SMTP_PORT;
    if (!/^[0-9]+$/.test(rawPort)) {
      throw new Error("SMTP_PORT must be a number from 1 to 65535.");
    }
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("SMTP_PORT must be a number from 1 to 65535.");
    }
    const config = {
      host,
      port,
      secure: port === 465,
    };
    if (port !== 465) config.requireTLS = true;
    if (env.SMTP_USER || env.SMTP_PASSWORD) {
      if (!env.SMTP_USER || !env.SMTP_PASSWORD) {
        throw new Error("SMTP_USER and SMTP_PASSWORD must both be set.");
      }
      config.auth = { user: env.SMTP_USER, pass: env.SMTP_PASSWORD };
    }
    return config;
  }
  return env.SMTP_URL || null;
}

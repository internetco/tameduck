# Self-hosting notes

This is an initial developer preview. A source publication and a production installation are separate operations. No hosted deployment configuration or service credentials are included.

## Required configuration

1. Use Node.js 24 with the native build tools needed by dependencies. Install locked dependencies using `npm ci`.
2. Run `npm run setup` once. Store the generated `.env` securely. `DATA_DIR` contains the database and persistent files; it must be private and writable by the app user. Keep its path outside a publicly served directory.
3. Build with `npm run build`, start with `npm start`, and use the one-time setup link to create the owner account.
4. Configure SMTP and test sign-in and recovery before inviting anybody else. Configure your own AI provider credentials in the app. Do not copy another installation's database or credentials.
5. For a network installation, put the loopback server behind an HTTPS reverse proxy, set `APP_URL` exactly, allow WebSockets and streaming, and support the application's upload sizes. Run the app as an unprivileged account.

## Isolation and external services

API-key inference and local subscription runtimes have different host requirements. The native subscription runtime needs Linux, its supported executable and companion, Bubblewrap, a delegated cgroup, and firewall rules that prevent the sandbox from reaching local/private services. Native agents wait for the startup isolation check to pass. A failed check, error, or timeout keeps them disabled; selecting host networking does not bypass this protection. Repair the host configuration and restart TameDuck to run verification again. The web application and API-key providers remain available while native agents are disabled. This check verifies the configured network boundary; operators must still verify the installation's other isolation requirements.

Remote computer actions run through the configured external computer service. Do not promise offline operation or zero usage costs. Provider URLs, account support, and native runtime compatibility must be checked for your installation.

Some optional native computer/runtime modules retain Linux installation paths and require host provisioning; they are not configured by the local preview setup. The existing OpenRouter connection is gated to the hosted deployments and is not available on arbitrary self-hosted origins in this preview. Other supported API-key connections can be configured in Settings. These limitations need resolving before advertising a complete self-hosted product.

## Data and recovery

After upgrading, older MCP connections using browser sign-in may need to be
reconnected once. Use **Reconnect account** in Connections when asked to sign in
again. This replaces saved sign-ins that lack the authorization-server binding
required by the MCP security update.

Back up the database consistently together with stored files, runtime state, and the matching vault encryption key. Test restoration into an isolated instance. Keep encrypted backups off the application machine. Replacing the encryption key without migrating existing encrypted data makes that data unreadable.

Installations process private conversations, files, integration credentials, and potentially external actions. Review permissions, retention, authentication, outbound connections, and incident handling for your own environment. The included generic privacy/terms pages describe the software; they are not a substitute for an operator's own notices and arrangements.

## Source availability

The community app exposes `/about` and links to it from Settings. Set `PUBLIC_SOURCE_URL` to the corresponding source for your deployed version, including your modifications. Preserve `LICENSE`, `NOTICE`, third-party notices, and the bundled skill license records.

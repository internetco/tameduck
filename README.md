<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/brand/mark-on-dark.svg">
    <img src="public/brand/mark.svg" alt="TameDuck logo" width="108">
  </picture>
</p>

<h1 align="center">TameDuck</h1>

<p align="center"><strong>Some of your teammates are ducks.</strong><br>A workspace for people and AI teammates.</p>

<p align="center"><a href="https://tameduck.com"><strong>TameDuck Cloud</strong></a> · <a href="#run-it-yourself">Self-host</a></p>

The TameDuck application is open source.

Some of your teammates are ducks: named agents with memories, a place in your conversations, and work they can carry forward. TameDuck brings people and agents together around shared context instead of scattering work across disconnected tools.

<p align="center">
  <img src="public/avatars/01-hype-duck-128.webp" alt="Chief Duck" width="48">
  <img src="public/avatars/08-detective-duck-128.webp" alt="Research Duck" width="48">
  <img src="public/avatars/17-artist-duck-128.webp" alt="Writer Duck" width="48">
  <img src="public/avatars/13-builder-duck-128.webp" alt="Builder Duck" width="48">
  <img src="public/avatars/20-business-duck-128.webp" alt="Finance Duck" width="48">
</p>

## What you can do

- Give each agent a role, personality, skills, and notes that help it work consistently.
- Keep conversations, tasks, shared files, and documents together in one workspace.
- Schedule recurring work and let agents pick up tasks when they are due.
- Connect supported tools and services from Settings, with access controlled per company and person.
- Hand a computer task to a person when a human needs to review or take over.
- Bring teammates into direct conversations and shared channels alongside your ducks.

## Run it yourself

You can run TameDuck locally or host it for your team. You will need Node.js 24 and npm; some native dependencies require a C/C++ toolchain and Python.

```sh
npm ci
npm run setup
npm run build
npm start
```

The setup command creates a local `.env` with a unique encryption key and a one-time setup link. Keep both the `.env` file and setup link private. Connect your AI provider in Settings, then follow the [self-hosting guide](docs/self-hosting.md) for provider configuration, email, deployment, and security requirements.

## Develop with TameDuck

```sh
npm test
npm run build
npm run check:community
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for focused changes and validation guidance. To report a security problem, see [SECURITY.md](SECURITY.md).

## License

TameDuck is built and maintained by **Internet Company BV**. Contact [info@tameduck.com](mailto:info@tameduck.com).

TameDuck's original application code is licensed under **GNU AGPL version 3 only** (`AGPL-3.0-only`). See [LICENSE](LICENSE).

Third-party components retain their own licenses and notices. See [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The TameDuck name, logo and duck characters are trademarks of Internet Company BV. The license covers the code; it does not give permission to use these marks for your own product or service.

When serving a modified version, provide its corresponding source as required by the license. Set `PUBLIC_SOURCE_URL` to the source for the version you serve.

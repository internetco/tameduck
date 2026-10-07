# Third-party material

The AGPL-3.0-only license covers TameDuck's original application code. Keep the following independently licensed material and its notices with redistributed copies.

- **Dependencies:** versions and integrity hashes are in `package-lock.json`. Each installed package contains its own license/notice files. This includes React, Express, the MCP SDK, noVNC, SheetJS, pdfmake, ONNX Runtime, and other dependencies; inspect those notices when distributing built artifacts.
- **noVNC:** see `public/third-party-notices.txt`; the unmodified code is licensed under MPL-2.0.
- **Cursor model:** `server/models/cursor/NOTICE` includes the upstream MIT license and pinned source/model information.
- **Skill catalog:** 1,000 independently licensed entries are stored in `server/data/skill-catalog/*.json.gz`, with source URLs, pinned revisions, full license text, notices, and supporting resource attribution. `server/data/skill-catalog.index.json` records licenses and bundle integrity hashes. The corpus includes MIT, Apache-2.0, CC-BY-SA-4.0, MPL-2.0, and BSD-3-Clause material. These are separately supplied instructions/resources, not relicensed application code. Do not strip their credits, source references, or license terms.
- **Fonts:** the font license texts are supplied under `public/fonts/licenses/`. Preserve those files with font redistributions.

Dependency updates and new bundled material need another license and attribution review. A successful source export is not a legal or security certification.

# Third-party notices

The root MIT license applies to this project's original code and documentation.
Third-party material retains its own license and attribution. Brand names and
trademarks belong to their respective owners; inclusion does not imply an
affiliation or endorsement, and the project license grants no trademark rights.

## Assistant logos — Lobe Icons

- Files: `extension/assets/chatgpt.svg`, `claude.svg`, `gemini.svg`, `qwen.svg`.
- Source: [Lobe Icons](https://github.com/lobehub/lobe-icons),
  `packages/static-svg/icons/openai.svg`, `claude-color.svg`,
  `gemini-color.svg`, and `qwen-color.svg`.
- Copyright (c) 2023 LobeHub.
- License: MIT. The complete upstream notice is retained in
  [extension/assets/LICENSE-lobe-icons](extension/assets/LICENSE-lobe-icons).
- Original SVG content is retained; filenames are adapted for this extension.

## QQ logo — Simple Icons

- File: `extension/assets/qq.svg`.
- Source: [Simple Icons](https://github.com/simple-icons/simple-icons),
  `icons/qq.svg`.
- License: CC0 1.0 Universal. The full notice is retained in
  [extension/assets/LICENSE-simple-icons](extension/assets/LICENSE-simple-icons).
- Original SVG content is retained. CC0 does not grant trademark rights.

## Feishu channel icon

- File: `extension/assets/feishu.png`.
- Source: the [official Feishu website favicon](https://www.feishu.cn/favicon.ico).
- Converted to a 48 × 48 PNG for local display identifying the Feishu channel.
- This third-party brand asset is not covered by this project's MIT license.
  No separate open-source license for this favicon was supplied with the asset.
  Rights remain with its owner; refer to the owner's terms for other uses.

All of these assets are bundled locally. Displaying the settings page does not
fetch logos from remote servers. Additional source details are retained in
[extension/assets/README.md](extension/assets/README.md).

## Development dependencies

The development dependencies are installed separately by `npm ci` and are not
bundled into the extension's runtime files:

| Dependency | Upstream | License |
| --- | --- | --- |
| `@napi-rs/canvas` | [Brooooooklyn/canvas](https://github.com/Brooooooklyn/canvas) | MIT |
| `jsdom` | [jsdom/jsdom](https://github.com/jsdom/jsdom) | MIT |
| `protobufjs` | [protobufjs/protobuf.js](https://github.com/protobufjs/protobuf.js) | BSD-3-Clause |

These packages and their transitive dependencies remain subject to their own
licenses. See each installed package's license files and `package-lock.json`
for the versions used. Their notices must be preserved if you redistribute
them separately or bundle them in a derivative distribution.

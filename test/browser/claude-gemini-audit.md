# Claude and Gemini Chromium audit

Run against an isolated temporary browser profile. Never attach this check to a logged-in browser.

1. From the project, run `node scripts/prepare-claude-gemini-browser-check.js`.
2. From a consistent working directory, run `playwright-cli -s=aichat-claude-gemini-audit open about:blank`.
3. Run `playwright-cli -s=aichat-claude-gemini-audit run-code --filename=<printed driver path>`.
4. Expect 42 passing cases: 21 for Claude and 21 for Gemini.
5. Close only this session using `playwright-cli -s=aichat-claude-gemini-audit close`.

The driver intercepts all HTTP requests and allows only ten explicit local files. The fixture executes the real extension adapters with sanitized captured markup, native browser editor behavior, native File/DataTransfer objects, actual PNG decoding, and local blob reads. It checks input and output images at counts 1 and 4, multiline prompt ownership, empty user-row hydration, drafts, remounts, disabled controls, streaming, completion, errors, and code whitespace.

This complements the Node DOM/content tests. It verifies browser semantics against captured structures; it does not claim that each live website still has those structures or that a QQ/Feishu round trip was performed.

# AGENTS.md

## Repository Overview

Pi extension that provides workflow tooling (`workflows`, `workflows_create`, `/workflow`) and embedded subdirectory `AGENTS.md` autoloading.

## Build & Verification

- Typecheck: `npx tsc --noEmit`
- Build: `npm run build`

## Notes

- Workflow storage path: `./.pi/workflows/<slug>/SKILL.md`
- Do not edit `dist/` manually.
- Subdirectory AGENTS context must stay payload-only; never persist hidden marker/custom-message placeholders for it, because `display: false` content can still leak visibly in some UIs.
- Every AGENTS context injection or re-injection MUST have a visible companion notification in the TUI (`↳ Loaded ...` or `↳ Refreshed ...`), but refresh timing belongs in `before_provider_request` so assistant/tool-driven follow-up requests can refresh too.
- Raw `<subdirectory_agents_context>...</subdirectory_agents_context>` XML must never be visible in the conversation. If it appears, the hiding/injection path is broken.
- `before_provider_request` is ephemeral; use it to append the current AGENTS XML body directly to the outgoing payload, and gate visible `Refreshed ...` by recency there too (see `tests/subdir-provider-payload.test.mjs`, `tests/subdir-recency-window-boundary.test.mjs`).
- For absolute targets outside cwd/home, derive autoload search root from nearest VCS root (`.git`/`.jj`/`.hg`) before falling back to drive root, or sibling-repo AGENTS autoload silently fails (see `tests/subdir-sibling-autoload.test.mjs`).
- Test mocks MUST store multiple handlers per event; a single-handler `Map.set()` silently drops the real `before_agent_start` subdir hook because this extension registers more than one handler on the same event (see `tests/subdir-recency-window-boundary.test.mjs`).
- Manual verification: prefer `pi -p --session <file>` from a sibling repo and inspect saved JSONL for `subdir-context-notify`; interactive PTY/TUI output is noisy and absence of persisted `subdir-context-autoload` is now expected after the marker-based fix.

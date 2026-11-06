# AGENTS.md — mdk-squared

## Communicating with the owner

- Answers must be SHORT and concise unless explicitly asked for detail.
- No essays, no preamble, no recap of what was already said. Less is more; quality over quantity.
- Lead with the answer. Evidence after, one or two lines max.
- Batch related points as terse bullets, not paragraphs.

## Repo rules

- One edit per file per batch; re-read before editing if anything touched the file since.

## Git discipline

- NEVER run `git commit` or `git push` — the owner commits. Stage/unstage hygiene only.
- Keys, `.env`, `data*/`, wn homes, sqlite, `.hex`/`.token` files stay out of the index (see .gitignore).
- Run `npx tsc --noEmit` in `app/` after TS changes; verify behavior with the tools in `app/tools/`.
- Env: root `.env` is compose's; `app/.env` is native runs. Keep both in sync. `RELAYS` = marmot, `WEATHER_RELAYS` = stations.

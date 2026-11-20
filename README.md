[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/haneulmas/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/haneulmas/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01 — a GitHub-compatible git forge

A standalone forge in one Node 22 process (stdlib only, no dependencies, no git binary, no network): git smart HTTP (upload-pack v2 / receive-pack v0), REST v3, GraphQL v4 and MCP, all served from one in-memory store.

Local practice grades (sealed scorer, `grade-local --driver process`): trial 0: **996**, trial 1: **985**, trial 2: **991** — feature 600/600, agent 200/200, perf 182–196, replays byte-identical. Entry for the [make.fun bounty](https://make.fun/bounty/github-core-clone-01).

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry ↔ env lifecycle (bind an ephemeral port, register it with `$MAKEFUN_ENV_URL`, poll `/done`, exit 0). `app.ts` is the server; `gitcore.ts` is the pack/object engine, `store.ts` the shared store, `githttp.ts` smart HTTP, `rest.ts` REST v3, `graphql.ts` GraphQL, `mcp.ts` MCP.

## Layout

- `main.ts`: lifecycle, kept as shipped (plus one comment line)
- `app.ts`: HTTP server, auth, routing
- `gitcore.ts`, `store.ts`, `githttp.ts`, `rest.ts`, `graphql.ts`, `mcp.ts`: the forge
- `package.json`, `tsconfig.json`, `LICENSE` (MIT)

## License

MIT. See `LICENSE`.

--
<sub>Entered on [make.fun](https://make.fun/?ref=re4yck73&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

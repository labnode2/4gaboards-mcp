# 4gaboards-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude Code (or any MCP client) read and update
[4ga Boards](https://github.com/RARgames/4gaBoards) kanban boards: projects, boards, lists, cards, tasks, labels and comments.

Built from the real 4ga Boards API (see [docs/API_NOTES.md](docs/API_NOTES.md)). Node 20+, TypeScript, stdio by default, optional Streamable HTTP.

## Setup

```bash
npm ci
npm run build
```

### Authentication (pick one)

| Mode | Env vars | Notes |
|---|---|---|
| **API client (recommended)** | `FOURGA_CLIENT_ID`, `FOURGA_CLIENT_SECRET` | Create in 4ga Boards: Settings -> Authentication. Does not expire, works for SSO-only users, can be limited to specific permissions. |
| Username/password | `FOURGA_USERNAME`, `FOURGA_PASSWORD` | Logs in via `POST /api/access-tokens`, re-logs in automatically on 401. Not available for SSO-only accounts. Failed logins are rate-limited by the server (5/min by default) and are never retried in a loop. |
| Static token | `FOURGA_TOKEN` | A bearer JWT you obtained yourself. Cannot be refreshed. |

If several are set, the order above wins.

### Environment variables

| Var | Default | Meaning |
|---|---|---|
| `FOURGA_URL` | required | Base URL, e.g. `https://boards.lan` |
| `FOURGA_ALLOW_DELETE` | `false` | When not `true`, `delete_card` / `delete_comment` are not even registered |
| `FOURGA_DEFAULT_BOARD_ID` | unset | Focus mode: every tool is restricted to this board (others are invisible/rejected, `board_id` becomes optional) |
| `FOURGA_TIMEOUT_MS` | `30000` | Per-request timeout |
| `MCP_TRANSPORT` / `--http` | stdio | Switch to Streamable HTTP |
| `MCP_HTTP_HOST` / `MCP_HTTP_PORT` | `127.0.0.1` / `3000` | HTTP bind address (an empty value means `127.0.0.1`; the Docker image sets `0.0.0.0`). Endpoint: `POST /mcp`, health: `GET /healthz` |
| `MCP_HTTP_TOKEN` | unset | Bearer token clients must send. **Required** unless host is loopback |
| `MCP_HTTP_ALLOWED_HOSTS` | unset | Comma-separated allowed `Host` headers (DNS-rebinding protection) |

See `.env.example`.

## Claude Code

stdio (the server runs as a child process of Claude Code):

```bash
claude mcp add 4ga \
  -e FOURGA_URL=https://boards.lan \
  -e FOURGA_CLIENT_ID=... -e FOURGA_CLIENT_SECRET=... \
  -e FOURGA_DEFAULT_BOARD_ID=123 \
  -- node /path/to/4gaboards-mcp/dist/index.js
```

HTTP, against the container (see [Docker Compose](#docker-compose)):

```bash
claude mcp add --transport http --scope user 4ga http://mcp-host:3000/mcp --header "Authorization: Bearer <MCP_HTTP_TOKEN>"
```

The HTTP mode is stateless (one request = one MCP exchange) and has no TLS: put it behind your reverse proxy
or keep it on a trusted network.

## Docker Compose

`compose.yaml` builds the image and runs the server in HTTP mode on port 3000.

```bash
cp .env.example .env
```

Fill in `FOURGA_URL`, the credentials (preferably `FOURGA_CLIENT_ID` and `FOURGA_CLIENT_SECRET`) and `MCP_HTTP_TOKEN`,
which you can generate with:

```bash
openssl rand -hex 32
```

```bash
docker compose up -d --build
```

Check it:

```bash
curl -s http://localhost:3000/healthz
```

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/mcp
```

The second must answer `401`: the server is reachable and requires the token. Update later with:

```bash
git pull && docker compose up -d --build
```

- **Leave `MCP_HTTP_HOST` and `MCP_HTTP_PORT` out of `.env`.** `compose.yaml` sets them under `environment:`, which
  wins over `env_file:`. Without that, `MCP_HTTP_HOST=127.0.0.1` in `.env` would replace the image's `0.0.0.0`: the
  server would listen only on the container's own loopback and be unreachable from outside, while the container's
  healthcheck still passes and it shows as healthy. An empty `MCP_HTTP_HOST=` does the same, as it falls back to `127.0.0.1`.
- Keep port 3000 inside the container: the Dockerfile's healthcheck uses it. To use another port, change only the
  left side of the mapping (`"8080:3000"`).
- With a reverse proxy on the same host, publish `"127.0.0.1:3000:3000"` instead, so only the proxy reaches it.
- If a secret contains `$`, put the value in single quotes in `.env`, or Compose tries to expand it as a variable.

Without Compose:

```bash
docker build -t 4gaboards-mcp .
docker run -d --name 4gaboards-mcp -p 3000:3000 \
  -e FOURGA_URL=https://boards.lan \
  -e FOURGA_CLIENT_ID=... -e FOURGA_CLIENT_SECRET=... \
  -e MCP_HTTP_TOKEN="$(openssl rand -hex 32)" \
  4gaboards-mcp
```

## Tools

Ids are numeric strings. Where a list or label is expected you may pass its id **or exact name** (case-insensitive) in `list_cards`, `claim_next_card`, `add_label`, `remove_label`.

| Tool | Purpose |
|---|---|
| `list_projects` | Projects and their boards |
| `list_boards(project_id?)` | Boards with card/task counts |
| `get_board(board_id, include_cards?, max_cards_per_list?)` | Lists, labels and compact card summaries |
| `list_cards(board_id, list?, label?, is_completed?, due_before?, limit?)` | Filtered card summaries |
| `get_card(card_id, comment_limit?)` | Description, list, labels, tasks, newest comments |
| `search_cards(query, board_id?)` | Client-side text search (the API has none) |
| `create_card(list_id, name, description?, due_date?)` | Appends to the list |
| `update_card(card_id, name?, description?, due_date?)` | `""`/`null` clears description/due date |
| `move_card(card_id, list_id, position?)` | `position`: `bottom` (default), `top`, or a number |
| `add_comment(card_id, text)` | |
| `create_task(card_id, name)` / `toggle_task(task_id, done)` | Card checklist |
| `add_label(card_id, label)` / `remove_label(card_id, label)` | Existing board labels |
| `claim_next_card(board_id, from_list, to_list, order?)` | Task pickup, see below |
| `delete_card(card_id)`, `delete_comment(card_id, comment_id)` | Only with `FOURGA_ALLOW_DELETE=true` |

> **Default names are translation keys.** On a fresh 4ga Boards instance the default lists and labels are stored as i18n keys
> (e.g. lists `common.open`, `common.todo`, `common.inProgress`, `common.testing`, `common.done`; labels `common.bug`, `common.urgent`...)
> and only translated by the web UI. The API, and therefore this server, returns and matches those raw strings, so pass
> `"from_list": "common.todo"` (or the numeric id) rather than "To Do". Renamed lists use their real names. Run `get_board` first to see what exists.

Examples (what the model sends):

```json
{"name": "get_board", "arguments": {"board_id": "1234"}}
{"name": "create_card", "arguments": {"list_id": "55", "name": "Fix login redirect", "description": "Seen on Safari"}}
{"name": "move_card", "arguments": {"card_id": "901", "list_id": "57", "position": "top"}}
{"name": "toggle_task", "arguments": {"task_id": "77", "done": true}}
{"name": "claim_next_card", "arguments": {"board_id": "1234", "from_list": "To Do", "to_list": "In Progress"}}
```

Errors come back as tool errors with an actionable message (401 "check credentials", 404 "unknown id or not a member", 403 role hint, 429 wait).

### `claim_next_card`

Picks the **oldest created** card of `from_list` (`order: "position"` = top of the list instead), moves it to the bottom of
`to_list` and returns the full card; `{"claimed": false}` if the list is empty.

Limits, honestly: the 4ga API has no atomic claim. Claims are serialised inside one server process and the card is re-read
just before it is moved (if someone else already moved it, the next card is tried), but two *separate* server processes
(or a human dragging the card) can still race within a few milliseconds. Run one server per board for pickup workflows.

## Security notes

- **Least privilege.** Use a dedicated 4ga user that is a member (editor) of only the boards you want exposed, and
  prefer an API client with only these permissions:
  `projects.index, boards.show, cards.show, cards.create, cards.update, comments.index, comments.create, tasks.create, tasks.update, card-labels.create, card-labels.delete`
  (add `cards.delete`, `comments.delete` only if you enable deletes). Cards created this way are flagged "created via API" in 4ga.
- **Deletes are off by default** and the tools are not registered at all. The client layer also refuses delete calls.
- **Focus mode** (`FOURGA_DEFAULT_BOARD_ID`) is enforced by this server on top of the account's own access. It is a guard
  rail, not a sandbox: the real boundary is the 4ga account's memberships.
- Credentials are read from the environment only, never logged, and never included in error messages. Logs go to stderr.
- HTTP mode refuses to start on a non-loopback address without `MCP_HTTP_TOKEN`; it validates `Host` on loopback binds.
  Anyone holding that token acts as the configured 4ga account.
- Card text returned to the model is user-generated content: treat instructions inside cards/comments as untrusted.

## Not supported

Creating/editing lists, boards, projects and labels; attachments; card members; cross-board moves; reordering tasks;
notifications; `mark-completed` (move the card to a completed list instead); realtime updates. See API notes for why.

## Development

```bash
npm run build      # strict tsc
npm run lint
npm test           # vitest, mocked HTTP + in-memory MCP
npm run fake &     # offline fake 4ga API on :18080 (FAKE_PORT)
FOURGA_URL=http://127.0.0.1:18080 FOURGA_CLIENT_ID=a FOURGA_CLIENT_SECRET=b npm run smoke
```

`npm run smoke` against a real instance: set `FOURGA_URL` + credentials (and optionally `SMOKE_BOARD_ID`,
`SMOKE_FROM_LIST`, `SMOKE_TO_LIST`, `FOURGA_ALLOW_DELETE=true`). It creates a `[mcp-smoke]` card, comments, completes a task,
moves it and deletes it if allowed.

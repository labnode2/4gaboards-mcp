# 4ga Boards API notes

Source of truth: `RARgames/4gaBoards` @ `ceab8d2` (package version 3.3.14), read from
`server/config/routes.js`, `server/api/controllers/**`, `server/api/policies/**`,
`server/api/helpers/**`, `server/api/models/**`, `packages/enums/src/permissions.js`.
Nothing below was guessed; items I could not confirm are marked **UNVERIFIED**.

## 1. Authentication

Two mechanisms exist (see `api/policies/is-authenticated.js`, `api/hooks/current-user`).

### 1a. Bearer access token (Planka-compatible)
- `POST /api/access-tokens` body `{ "emailOrUsername": string, "password": string }`
  -> `200 { "item": "<JWT>" }`.
- Send as `Authorization: Bearer <JWT>` on `/api/*`.
- JWT lifetime: `TOKEN_EXPIRES_IN` days (default **365**). A `Session` row is also required,
  and the token is invalidated if the user changes their password (`passwordChangedAt`).
  Sessions are cleaned up by a cron job -> a token can start returning 401 before expiry.
- Failure: `401 { code: "E_UNAUTHORIZED", message: "Invalid username or password" }`.
- **Rate limit** (`rate-limit-auth`): by default 5 failed attempts per >=60 s window per
  identifier+IP, then `429 { code: "E_TOO_MANY_REQUESTS", ... }`. => never retry a failed login in a loop.
- `emailOrUsername` validator: email, or username 3-16 chars `[a-zA-Z0-9_.]`.
- **SSO-only users have no password** (`!user.password` -> login fails). They cannot use this flow.
- `DELETE /api/access-tokens/me` revokes the current token.

### 1b. API clients (not in Planka) - recommended
- Created in the UI (Settings -> Authentication) or via `POST /api/api-clients`
  (`{name, permissions: string[]}`); the response contains `clientSecret` once only.
- Send headers `X-Client-Id` and `X-Client-Secret` on every request. No login, no expiry, works for SSO users.
- Acts as the owning user (board roles still apply) but is additionally limited by `permissions`.
- Permission = controller action with `/` -> `.`, e.g. `cards/update` -> `cards.update`.
  Supported: `*`, `group.*`, exact. Invalid/insufficient -> `401 "Invalid client credentials"`
  (NB: 401, not 403).
- Cards created with an API client get `isCreatedViaApi: true`.
- Gotcha: `cards.mark-completed`, `boards.find-label-by-name` are **not** in the UI permission
  enum, so only `*`/group wildcards grant them. The server therefore avoids these endpoints.
- Each request costs a bcrypt compare on the server (fine at this scale).

### Decision
Support three modes, precedence in this order: API client (`FOURGA_CLIENT_ID`+`FOURGA_CLIENT_SECRET`),
username/password (login + auto re-login on 401), static `FOURGA_TOKEN` (bearer; cannot refresh).

## 2. Conventions
- All ids are **numeric strings** (`/^[0-9]+$/`, bigint) - always handle as strings.
- Success: `{ item }` or `{ items }`, plus optional `included: {...}`.
- Errors: `{ code, message }` with `E_UNAUTHORIZED` 401, `E_FORBIDDEN` 403, `E_NOT_FOUND` 404,
  `E_CONFLICT` 409, `E_UNPROCESSABLE_ENTITY` 422, `E_TOO_MANY_REQUESTS` 429.
  Invalid input falls to Sails' default 400 (**UNVERIFIED** body shape; client treats body as opaque text/JSON).
- Non-members get **404** (not 403) for resources they cannot see; viewers get 403 `Not enough rights` on writes.
- Roles: board membership `editor` (write) / `viewer` (read; may comment only if `canComment`).
  Project managers can read all boards of the project.
- Positions are floats; lower = higher in list. `positionGap` = 65535. The server repositions on collisions.

## 3. Endpoints used

| Purpose | Method + path | Body / query | Response |
|---|---|---|---|
| login | `POST /api/access-tokens` | `emailOrUsername,password` | `{item: jwt}` |
| projects + boards | `GET /api/projects` | - | `{items: Project[], included:{boards[] (with cardTotal,cardCompleted,taskTotal,taskCompleted), boardMemberships, users, projectManagers}}` |
| board snapshot | `GET /api/boards/:id` | - | `{item: Board, included:{lists, cards, labels, cardLabels, tasks, cardMemberships, taskMemberships, attachments, users, boardMemberships, projects}}` |
| card | `GET /api/cards/:id` | - | `{item: Card, included:{tasks, cardLabels, cardMemberships, attachments}}` (**no comments, no label names**) |
| comments | `GET /api/cards/:cardId/comments?beforeId=` | - | `{items: Comment[] (newest first, max 50), included:{users}}` |
| create card | `POST /api/lists/:listId/cards` | `name` (req), `description?`, `position?` (appends if omitted), `dueDate?` | `{item: Card}` |
| update card | `PATCH /api/cards/:id` | `name?, description? (non-empty or null), dueDate? (ISO-8601 strict or null), listId?, position?` | `{item: Card}` |
| delete card | `DELETE /api/cards/:id` | - | `{item}` |
| comment | `POST /api/cards/:cardId/comments` | `text` | `{item: Comment}` (text in `item.data.text`) |
| delete comment | `DELETE /api/comments/:id` | - | soft delete; `{item}` |
| task | `POST /api/cards/:cardId/tasks` | `name`, `position?`, `isCompleted?` | `{item: Task}` |
| task update | `PATCH /api/tasks/:id` | `isCompleted?, name?` | `{item: Task}` |
| add label | `POST /api/cards/:cardId/labels` | `labelId` | `{item: CardLabel}`; 409 if already present |
| remove label | `DELETE /api/cards/:cardId/labels/:labelId` | - | `{item}`; 404 if absent |

Shapes (from models): Card `{id,boardId,listId,name,description,position,isCompleted,completedAt,dueDate,timer,commentCount,isCreatedViaApi,coverAttachmentId,createdAt,updatedAt,...}`;
List `{id,boardId,name,position,isCollapsed,isCompleted}`; Task `{id,cardId,name,position,isCompleted,dueDate}`;
Label `{id,boardId,name|null,color}`; CardLabel `{id,cardId,labelId}`; Comment `{id,cardId,userId,data:{text,userId,userName},createdAt}`.

Minimal API-client permission set for every tool here:
`projects.index, boards.show, cards.show, cards.create, cards.update, comments.index, comments.create,
tasks.create, tasks.update, card-labels.create, card-labels.delete` (+ `cards.delete`, `comments.delete` only with deletes enabled).

## 4. Gaps and how the server works around them
- **No `GET /lists/:id`, no list->cards endpoint, no tasks/:id GET, no search endpoint.** Cards are
  read from the board snapshot; a list id alone cannot be mapped to a board. So `list_cards` needs a
  board (or focus board); `search_cards` is client-side substring search over name/description of
  board snapshots (all accessible boards when none given; capped).
- **Moving a card needs `position`** (else 422 `Position must be present`). `move_card` computes it
  from the board snapshot (`top`/`bottom`/number; default bottom). Moving to a list with
  `isCompleted` flips the card's completion server-side.
- **Cross-board move** (`boardId` on PATCH) resets labels; not exposed.
- **No atomic claim endpoint.** `claim_next_card` = in-process mutex + re-read of the card right before
  the PATCH. Safe for one server process; across several processes there is a small race window.
  "Oldest" is ambiguous (createdAt vs list position): default `created` (oldest createdAt, tie: position),
  option `position` (top of list first).
- **Label names** only come from the board snapshot (`find-label-by-name` needs a non-enumerated permission).
- **No comment GET by id**: `delete_comment` takes `card_id` + `comment_id` and verifies the comment is on that card.
- Realtime is Sails socket.io; not used (request/response only).
- `mark-completed` (`POST /api/cards/:id/mark-completed`) exists but is not used (permission gotcha above);
  move the card to a completed list instead.
- Focus mode (`FOURGA_DEFAULT_BOARD_ID`) is enforced client-side by checking each target's `boardId`
  (card/list/task/label lookups via the board snapshot).

# Next move

A multi-user job-search tracker where **users bring their own AI**. Next move never calls a model or scrapes a job board. It hands each user a prompt to paste into the agent they already use (Claude Code, Codex, Cursor…). The agent asks for their CV, researches openings, explains why each fits, and writes the results back through a narrow, per-user API.

Built on Spacefast's [Zero runtime](https://spacefast.com/docs/zero-runtime/): TypeScript and Preact, a MySQL database per Space, and built-in visitor sign-in (Google, WordPress.com).

## How agents connect

| Lane | How | Works with |
| --- | --- | --- |
| One-time code | Each copied prompt has a single-use code that expires in 30 minutes. The agent exchanges it (`POST /api/agent/session`) for an API key that lasts 6 hours. | Any agent that can make HTTP requests |
| MCP | The user creates a 90-day key on the Agent page and adds `/mcp` to their agent, sending the key as a bearer header. | Claude Code, Cursor, Codex |

ChatGPT and Claude.ai connectors would need OAuth on top of this; see "Not built yet".

### Security model

- **Keys are stored only as HMACs.** The plaintext key is shown once, and a database leak can't be replayed.
- **Private data is encrypted, and rows are anonymous.** See "Encryption at rest" below.
- **What an agent's key can do:** read the profile and roles, read job keys/URLs/statuses for deduplication, save research, set company icons, and log runs.
- **What it can't do:** change application status, read or write notes, delete anything, or reach another user's data. This is enforced server-side in `server/data.ts`, not by the prompt.
- **Revoking works immediately.** Every request re-checks revocation, expiry, and membership, so blocking someone also locks out their agents.
- **Batches are all-or-nothing.** A batch with any problem saves nothing, and the error lists every problem.
- **MCP rejects foreign origins.** A request with a browser `Origin` header that isn't this site gets a 403.
- **People can delete everything.** "Delete my data" (Profile & roles → Your data) removes every row the person owns in one transaction. That includes their agent keys, so their agents stop working, and their membership, so their seat opens up. Blocked people get the same button on their "No access" screen. The client asks them to type DELETE, and the `deleteAccount` mutation checks that word again.

### What deleting doesn't reach

- **The sign-in record.** Spacefast keeps a visitor account for everyone who signs in: email address and linked provider. The app can't remove it. The operator does that from **Users** in the Spacefast dashboard.
- **Backups.** Spacefast's docs don't describe database backups or how long they're kept.

### Encryption at rest

The goal: the operator can't casually read anyone's data, whether through the dashboard's table browser, `sf db dump`, an export, the SQL console, or an AI agent holding Spacefast credentials.

| Stored | How |
| --- | --- |
| Profile, roles (titles, salary targets, notes), run summaries | Encrypted |
| Per-job judgment of the user: `fit`, `eligibility`, `fitSummary`, `caveats`, `salaryNote` | Encrypted |
| Application `status` and `notes` | Encrypted |
| `ownerId` on every row | Keyed hash of the account ID (`o1_…`), so a row can't be matched to a person on Spacefast's Users page |
| Emails (members, agent keys, handoffs) | Keyed hash (`h1_…`), used only to apply `BLOCKED_EMAILS`. Display names aren't stored. |
| Job postings: title, company, URLs, location, salary, highlights | Plain. They're public, and the app looks rows up by them. |

**How it works.** Zero's sandbox has no AES and no random numbers. Its only keyed primitive is HMAC-SHA256, which `server/vault.ts` builds into deterministic authenticated encryption (SIV style). An HMAC of the text and its context gives a 16-byte IV that doubles as the integrity tag. HMACs of that IV, with a counter, generate the keystream. Each value is bound to its table, owner, row and field, so it can't be moved elsewhere. The cost of determinism is that an unchanged value looks unchanged. `server/sealed.ts` lists the encrypted fields.

**The key.** `DATA_KEY` is a write-only Space secret. Handler code passes its *name* to `ctx.crypto`, so the value never enters JavaScript, and Spacefast never shows it again after it's set. Every ciphertext carries a short fingerprint of the key, so data sealed under a different key fails loudly instead of decrypting to garbage.

**What it doesn't stop.** Deploying code that decrypts on purpose. Spacefast itself, which holds both the data and the key. Inference from someone's list of saved jobs. It makes reading someone's data a deliberate act, not a glance.

**Cost.** Production does an HMAC in about 0.015 ms. Decrypting a 28-job workspace takes a few hundred of them, plus QuickJS byte-shuffling.

**Upgrading old rows.** Rows written before encryption are upgraded per owner, inside one transaction, the first time that owner shows up. A member gets a "Welcome back" screen whose Continue button runs it, and an old agent key triggers it on its first write-capable request.

### Secure random numbers in Zero

Zero handlers have no `crypto.getRandomValues`. `server/tokens.ts` takes its randomness from `ctx.jwt.sign`, whose random `jti` comes from the runtime, and HMACs that with `TOKEN_PEPPER`. If Zero adds a random-bytes API, swap it in there.

## Layout

```
shared/contract.ts   Validation and enums shared by the API, MCP and UI
shared/prompts.ts    The prompts users copy, and the MCP research guide
server/access.ts     Membership: the open-seat cap, invitations, blocking
server/vault.ts      Field encryption and keyed hashes, built on HMAC
server/sealed.ts     Which fields are encrypted, and upgrading pre-encryption rows
server/tokens.ts     Secret minting and hashing
server/data.ts       Every read/write: agent operations, user operations, keys
server/mcp.ts        Stateless MCP over Streamable HTTP (JSON responses)
server/index.ts      Schema, queries, mutations, HTTP endpoints
client/, pages/      UI (Opportunities, Your agent, Profile & roles)
tests/               Node tests against an in-memory fake of the Zero context
```

## Configuration

`.env.server` is git-ignored. `sf publish` copies every key in it into the Space as a secret, so it may only hold values that are meant for production:

```
TOKEN_SEED=<base64url 32-byte Ed25519 seed>   # used only as an entropy source
TOKEN_PEPPER=<long random string>             # HMAC key for stored secrets
```

`DATA_KEY` must **never** go in `.env.server`. A publish would overwrite the production key, and every encrypted value would stop decrypting. A test fails if it appears there. Set it once, straight from a generator, so nobody ever sees it:

```sh
openssl rand -base64 32 | tr -d '\n' | sf env set DATA_KEY --secret --value-from-stdin
```

Losing it means losing every encrypted value, and there's no rotation yet. Keep an offline copy if you'd rather risk being able to read the data than risk losing it.

### Who can join

Next move is open to the first 50 people. After that it's invite-only. Signing in doesn't take a seat; pressing **Claim my spot** does. Filling up, or lowering the cap later, never removes anyone who already joined.

Set these on the Space with `sf env set NAME --no-secret --value "..."`, not in `.env.server`. All of them are optional.

| Variable | Effect |
| --- | --- |
| `MEMBER_CAP` | Open seats, 50 by default. `0` makes Next move invite-only from the start. |
| `ALLOWED_EMAILS`, `ALLOWED_USER_IDS` | Invitations. These people can join even when every seat is taken, and they count toward the total. Emails must be verified by the sign-in provider. |
| `BLOCKED_EMAILS`, `BLOCKED_USER_IDS` | The off switch. Blocks the person and their agents on the next request and frees their seat. Their data stays. |

Values are comma-separated. Emails are case-insensitive; user IDs must match exactly. A user ID is shown on the "Next move is full" screen to anyone whose sign-in has no email.

The seat check counts members and then inserts a row, and those two steps aren't atomic: Zero has no unique constraints and doesn't document its isolation level. If two people claim the last seat at the same moment, both can get in. The cap is a limit on growth, not a billing guarantee.

Rotating `TOKEN_PEPPER` invalidates every issued key and code.

## Develop

```sh
npm install
npm test            # API, MCP and access rules against a fake context
npm run typecheck
sf dev              # local server; it only supports guests, so member pages need a deployed Space
```

## Agent API

All routes except `session` and `guide` need `Authorization: Bearer nmk_...`.

| Route | Purpose |
| --- | --- |
| `POST /api/agent/session` | `{code, agentName}` → `{apiKey, expiresAt}` |
| `GET /api/agent/guide` | The research guide (Markdown) |
| `GET /api/agent/context` | Profile, roles, tracked jobs (no notes) |
| `PUT /api/agent/profile` | `{profile}` |
| `POST /api/agent/tracks` | `{tracks: [...]}`, upsert by key |
| `POST /api/agent/jobs` | `{jobs: [...]}`, at most 25, upsert by key |
| `POST /api/agent/icons` | `{icons: [{key, icon}]}`: sets only the company icon on tracked jobs |
| `POST /api/agent/runs` | `{summary, added, updated, closed}` |
| `POST /mcp` | MCP tools: `get_instructions`, `get_context`, `save_profile`, `save_tracks`, `save_jobs`, `save_company_icons`, `log_run` |

## Not built yet

- OAuth for ChatGPT and Claude.ai connectors (step 3 of the plan).
- Importing application statuses and notes from the old single-user app. Its research imports through the agent API unchanged.
- Cleaning up expired handoff codes. They're harmless, but they accumulate.

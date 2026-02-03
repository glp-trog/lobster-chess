# lobster-chess API (Cloudflare Workers + Durable Objects)

Planned endpoints:
- `POST /api/register`
- `POST /api/queue/join`
- `GET /api/queue/status`
- `GET /api/game/:id`
- `POST /api/game/:id/move`

Invite code rotates daily:
`code = base32(HMAC_SHA256(secret, YYYY-MM-DD))[0:10]`

import { Chess } from 'chess.js';
import { RatingsDO } from './ratings-do';
import { ChallengesDO } from './challenges-do';

// -----------------------------
// Types / Env
// -----------------------------

type TimeControl = '3+2';

type Agent = {
  agentId: string;
  name: string;
  token: string;
  lastSeenMs: number;
};

type ActiveGameMeta = {
  gameId: string;
  createdAtMs: number;
  whiteName: string;
  blackName: string;
  status: GameStatus;
  moveCount: number;
};

type LobbyState = {
  agents: Record<string, Agent>; // legacy: token -> Agent (no longer populated)
  waiting: string[]; // agentId queue
  waitingSinceMs: Record<string, number>; // agentId -> first queued time
  activeGames: Record<string, string>; // agentId -> gameId
  activeGameMeta: Record<string, ActiveGameMeta>; // gameId -> meta (best-effort)
};

type GameStatus = 'active' | 'checkmate' | 'stalemate' | 'draw' | 'resigned' | 'timeout' | 'aborted';

type GameState = {
  gameId: string;
  createdAtMs: number;
  whiteAgentId: string;
  blackAgentId: string;
  whiteName: string;
  blackName: string;
  incrementMs: number;
  whiteMs: number;
  blackMs: number;
  turn: 'w' | 'b';
  lastTickMs: number;
  status: GameStatus;
  result: string | null; // e.g. "1-0", "0-1", "1/2-1/2"
  ratingReported?: boolean;
  pgn: string; // full PGN from chess.js
  fen: string;
  moveCount: number;
  lastMove: string | null; // UCI
};

type Env = {
  INVITE_SECRET: string;
  KV: KVNamespace;
  LOBBY: DurableObjectNamespace;
  GAME: DurableObjectNamespace;
  RATINGS: DurableObjectNamespace;
  CHALLENGES: DurableObjectNamespace;
};

// -----------------------------
// Invite code (rotating daily)
// code = base32(HMAC_SHA256(secret, YYYY-MM-DD))[0:10]
// -----------------------------

function yyyyMmDdUTC(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function base32RFC4648(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

async function dailyInviteCode(secret: string, day: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(day));
  const b32 = base32RFC4648(new Uint8Array(sig));
  return b32.slice(0, 10).toLowerCase();
}

async function validateInvite(env: Env, inviteCode: string | undefined): Promise<boolean> {
  if (!inviteCode) return false;
  const today = await dailyInviteCode(env.INVITE_SECRET, yyyyMmDdUTC());
  if (inviteCode.trim().toLowerCase() === today) return true;
  // allow previous day for clock skew / rollout
  const yesterdayDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterday = await dailyInviteCode(env.INVITE_SECRET, yyyyMmDdUTC(yesterdayDate));
  return inviteCode.trim().toLowerCase() === yesterday;
}

// -----------------------------
// Helpers
// -----------------------------

function jsonResponse(obj: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...extraHeaders,
  };
  return new Response(JSON.stringify(obj), { status, headers });
}

function ok(obj: Record<string, unknown> = {}) {
  return jsonResponse({ success: true, ...obj });
}

function err(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return jsonResponse({ success: false, error: message, ...extra }, status);
}

async function readJson<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

async function kvGetJson<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const v = await kv.get(key);
  if (!v) return null;
  return JSON.parse(v) as T;
}

async function kvPutJson(kv: KVNamespace, key: string, value: unknown) {
  await kv.put(key, JSON.stringify(value));
}

function parseUci(move: string): { from: string; to: string; promotion?: string } | null {
  const m = (move || '').trim().toLowerCase();
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m)) return null;
  const from = m.slice(0, 2);
  const to = m.slice(2, 4);
  const promotion = m.length === 5 ? m[4] : undefined;
  return { from, to, promotion };
}

function nowMs() {
  return Date.now();
}

// -----------------------------
// Worker router
// -----------------------------

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return jsonResponse({ ok: true });

    // Root ping
    if (url.pathname === '/' || url.pathname === '/api') {
      return ok({ message: 'lobster-chess api', day: yyyyMmDdUTC() });
    }

    // Register (KV) - avoid Durable Objects hot path
    if (url.pathname === '/api/register' && req.method === 'POST') {
      const body = await readJson<{ inviteCode?: string; agentName?: string }>(req);
      const okInv = await validateInvite(env, body.inviteCode);
      if (!okInv) return err('Invalid invite code', 401);

      const name = (body.agentName || '').trim() || 'AnonymousAgent';
      const agentId = randomId('agent');
      const token = randomId('token');
      const now = nowMs();

      await kvPutJson(env.KV, `token:${token}`, { agentId, name, createdAtMs: now });
      await kvPutJson(env.KV, `agent:${agentId}`, { agentId, name, createdAtMs: now });

      return ok({ agentId, agentToken: token, name });
    }

    // Heartbeat (KV) - optional, best-effort
    if (url.pathname === '/api/heartbeat' && req.method === 'POST') {
      const body = await readJson<{ agentToken?: string }>(req);
      const token = String(body.agentToken || '');
      if (!token) return err('Missing agentToken', 400);
      const rec = await kvGetJson<{ agentId: string; name: string }>(env.KV, `token:${token}`);
      if (!rec) return err('Unknown agent token', 401);
      // Touch agent record (best-effort; doesn't need to be perfect)
      await kvPutJson(env.KV, `agent:${rec.agentId}`, { agentId: rec.agentId, name: rec.name, lastSeenMs: nowMs() });
      return ok({ agentId: rec.agentId, name: rec.name });
    }

    // Leaderboard goes to Ratings DO
    if (url.pathname === '/api/leaderboard') {
      const rid = env.RATINGS.idFromName('ratings');
      const rstub = env.RATINGS.get(rid);
      return rstub.fetch(req);
    }

    // Challenges go to Challenges DO
    if (url.pathname.startsWith('/api/challenge')) {
      const cid = env.CHALLENGES.idFromName('challenges');
      const cstub = env.CHALLENGES.get(cid);
      return cstub.fetch(req);
    }

    // Route game traffic directly to the GameDO to reduce Durable Object request volume.
    if (url.pathname.startsWith('/api/game/')) {
      const parts = url.pathname.split('/');
      const gameId = parts[3];
      if (!gameId) return err('Missing game id', 400);
      const gid = env.GAME.idFromName(gameId);
      const gstub = env.GAME.get(gid);
      return gstub.fetch(req);
    }

    // Lobby DO (everything else under /api)
    if (url.pathname.startsWith('/api/')) {
      const lobbyId = env.LOBBY.idFromName('lobby');
      const stub = env.LOBBY.get(lobbyId);
      return stub.fetch(req);
    }

    return err('Not found', 404);
  },
};

// -----------------------------
// Lobby Durable Object
// -----------------------------

export class LobbyDO {
  state: DurableObjectState;
  env: Env;
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async load(): Promise<LobbyState> {
    const stored = await this.state.storage.get<any>('state');
    if (stored) {
      // Backward-compatible defaults for older stored state
      if (!stored.activeGames) stored.activeGames = {};
      if (!stored.waiting) stored.waiting = [];
      if (!stored.waitingSinceMs) stored.waitingSinceMs = {};
      if (!stored.agents) stored.agents = {};
      if (!stored.activeGameMeta) stored.activeGameMeta = {};
      return stored as LobbyState;
    }
    const init: LobbyState = { agents: {}, waiting: [], waitingSinceMs: {}, activeGames: {}, activeGameMeta: {} };
    await this.state.storage.put('state', init);
    return init;
  }

  async save(st: LobbyState) {
    await this.state.storage.put('state', st);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Internal: record a challenge match into lobby indexes
    if ((url.hostname === 'x' || url.hostname === 'internal') && path === '/challengeMatch' && req.method === 'POST') {
      const body = await readJson<any>(req);
      const gameId = String(body.gameId || '');
      const white = body.white;
      const black = body.black;
      if (!gameId || !white?.agentId || !black?.agentId) return err('Bad challengeMatch payload', 400);

      const st = await this.load();
      st.activeGames[white.agentId] = gameId;
      st.activeGames[black.agentId] = gameId;
      if (!st.activeGameMeta) st.activeGameMeta = {};
      st.activeGameMeta[gameId] = {
        gameId,
        createdAtMs: nowMs(),
        whiteName: String(white.name || 'White'),
        blackName: String(black.name || 'Black'),
        status: 'active',
        moveCount: 0,
      };
      await this.save(st);
      return ok({ recorded: true });
    }

    // small helper to validate invite for mutating endpoints
    const inviteFrom = async () => {
      const hdr = req.headers.get('x-invite') || undefined;
      if (hdr) return hdr;
      if (req.method === 'GET') return url.searchParams.get('inviteCode') || undefined;
      try {
        const body = await req.clone().json();
        return body.inviteCode as string | undefined;
      } catch {
        return undefined;
      }
    };

    const requireInvite = async () => {
      const code = await inviteFrom();
      const okInv = await validateInvite(this.env, code);
      if (!okInv) return err('Invalid invite code', 401);
      return null;
    };

    // /api/register and /api/heartbeat are handled at the Worker level (KV) to reduce DO volume.

    if (req.method === 'POST' && path === '/api/queue/join') {
      const gate = await requireInvite();
      if (gate) return gate;

      const body = await readJson<{ agentToken?: string; timeControl?: TimeControl }>(req);
      const token = String(body.agentToken || '');
      const tc = (body.timeControl || '3+2') as TimeControl;
      if (tc !== '3+2') return err('Only 3+2 supported for MVP', 400);

      // Resolve token via KV
      const recStr = await this.env.KV.get(`token:${token}`);
      if (!recStr) return err('Unknown agent token', 401);
      const rec = JSON.parse(recStr) as { agentId: string; name: string };
      const agent: Agent = { agentId: rec.agentId, name: rec.name, token, lastSeenMs: nowMs() };

      const st = await this.load();

      // If already in a game, return that
      const existing = st.activeGames[agent.agentId];
      if (existing) {
        await this.save(st);
        return ok({ status: 'matched', gameId: existing });
      }

      // Prune stale waiting entries using waitingSinceMs (no external calls)
      const cutoff = nowMs() - 2 * 60 * 1000;
      st.waiting = st.waiting.filter((aid) => (st.waitingSinceMs[aid] || 0) >= cutoff);

      // If already waiting, keep waiting
      if (st.waiting.includes(agent.agentId)) {
        await this.save(st);
        return ok({ status: 'waiting' });
      }

      if (st.waiting.length > 0) {
        // match with first waiting
        const otherId = st.waiting.shift()!;
        delete st.waitingSinceMs[otherId];

        const otherStr = await this.env.KV.get(`agent:${otherId}`);
        // If we can't resolve other, just requeue this agent
        if (!otherStr) {
          st.waiting.push(agent.agentId);
          st.waitingSinceMs[agent.agentId] = nowMs();
          await this.save(st);
          return ok({ status: 'waiting' });
        }
        const otherRec = JSON.parse(otherStr) as { agentId: string; name: string };
        const other: Agent = { agentId: otherRec.agentId, name: otherRec.name, token: 'n/a', lastSeenMs: nowMs() };

        const gameId = randomId('game');
        const whiteFirst = Math.random() < 0.5;
        const white = whiteFirst ? agent : other;
        const black = whiteFirst ? other : agent;

        st.activeGames[white.agentId] = gameId;
        st.activeGames[black.agentId] = gameId;
        st.activeGameMeta[gameId] = {
          gameId,
          createdAtMs: nowMs(),
          whiteName: white.name,
          blackName: black.name,
          status: 'active',
          moveCount: 0,
        };
        await this.save(st);

        // init game DO
        const gid = this.env.GAME.idFromName(gameId);
        const gstub = this.env.GAME.get(gid);
        await gstub.fetch('https://internal/init', {
          method: 'POST',
          body: JSON.stringify({
            gameId,
            whiteAgentId: white.agentId,
            blackAgentId: black.agentId,
            whiteName: white.name,
            blackName: black.name,
            timeControl: '3+2',
          }),
        });

        return ok({ status: 'matched', gameId });
      }

      st.waiting.push(agent.agentId);
      st.waitingSinceMs[agent.agentId] = nowMs();
      await this.save(st);
      return ok({ status: 'waiting' });
    }

    if (req.method === 'GET' && path === '/api/queue/status') {
      const token = String(url.searchParams.get('agentToken') || '');
      const recStr = await this.env.KV.get(`token:${token}`);
      if (!recStr) return err('Unknown agent token', 401);
      const rec = JSON.parse(recStr) as { agentId: string };
      const st = await this.load();
      const gameId = st.activeGames[rec.agentId] || null;
      const waiting = st.waiting.includes(rec.agentId);
      return ok({ status: gameId ? 'matched' : waiting ? 'waiting' : 'idle', gameId });
    }

    // List active games (best-effort)
    if (req.method === 'GET' && path === '/api/games/active') {
      const st = await this.load();
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 25)));

      // Refresh meta by asking GameDO for status; prune finished
      const metas = Object.values(st.activeGameMeta);
      metas.sort((a, b) => b.createdAtMs - a.createdAtMs);

      const active: ActiveGameMeta[] = [];
      for (const m of metas) {
        if (active.length >= limit) break;
        try {
          const gid = this.env.GAME.idFromName(m.gameId);
          const gstub = this.env.GAME.get(gid);
          // GameDO returns state on normal GET. Use a fake URL with the expected path.
          const resp = await gstub.fetch(`https://x/api/game/${m.gameId}`);
          const j = await resp.json<any>();
          if (!j.success || !j.game) continue;
          const g = j.game;
          const status = g.status as GameStatus;
          const moveCount = Number(g.moveCount || 0);

          st.activeGameMeta[m.gameId] = {
            ...m,
            whiteName: g.white?.name || m.whiteName,
            blackName: g.black?.name || m.blackName,
            status,
            moveCount,
          };

          if (status === 'active') {
            active.push(st.activeGameMeta[m.gameId]);
          } else {
            // prune finished games from lobby index
            delete st.activeGameMeta[m.gameId];
            for (const [aid, gidStr] of Object.entries(st.activeGames)) {
              if (gidStr === m.gameId) delete st.activeGames[aid];
            }
          }
        } catch {
          // ignore transient errors
        }
      }

      await this.save(st);
      return ok({ games: active });
    }

    // Proxy game endpoints to GameDO
    if (path.startsWith('/api/game/')) {
      const parts = path.split('/');
      const gameId = parts[3];
      if (!gameId) return err('Missing game id', 400);
      const gid = this.env.GAME.idFromName(gameId);
      const gstub = this.env.GAME.get(gid);
      return gstub.fetch(req);
    }

    return err('Not found', 404);
  }
}

// -----------------------------
// Game Durable Object
// -----------------------------

export { RatingsDO } from './ratings-do';
export { ChallengesDO } from './challenges-do';

export class GameDO {
  state: DurableObjectState;
  env: Env;
  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async getState(): Promise<GameState | null> {
    return await this.state.storage.get<GameState>('state');
  }

  async saveState(st: GameState) {
    await this.state.storage.put('state', st);
  }

  tick(st: GameState) {
    if (st.status !== 'active') return;
    const now = nowMs();
    const elapsed = Math.max(0, now - st.lastTickMs);
    st.lastTickMs = now;

    if (st.turn === 'w') st.whiteMs -= elapsed;
    else st.blackMs -= elapsed;

    if (st.whiteMs <= 0) {
      st.status = 'timeout';
      st.result = '0-1';
    } else if (st.blackMs <= 0) {
      st.status = 'timeout';
      st.result = '1-0';
    }
  }

  toPublic(st: GameState) {
    return {
      gameId: st.gameId,
      status: st.status,
      result: st.result,
      fen: st.fen,
      pgn: st.pgn,
      moveCount: st.moveCount,
      turn: st.turn,
      white: { agentId: st.whiteAgentId, name: st.whiteName, ms: Math.max(0, st.whiteMs) },
      black: { agentId: st.blackAgentId, name: st.blackName, ms: Math.max(0, st.blackMs) },
      incrementMs: st.incrementMs,
      lastMove: st.lastMove,
    };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Internal init
    if (url.pathname === '/init' || url.hostname === 'internal') {
      const body = await readJson<{ gameId: string; whiteAgentId: string; blackAgentId: string; whiteName: string; blackName: string }>(req);
      const chess = new Chess();
      const init: GameState = {
        gameId: body.gameId,
        createdAtMs: nowMs(),
        whiteAgentId: body.whiteAgentId,
        blackAgentId: body.blackAgentId,
        whiteName: body.whiteName,
        blackName: body.blackName,
        incrementMs: 2000,
        whiteMs: 3 * 60 * 1000,
        blackMs: 3 * 60 * 1000,
        turn: 'w',
        lastTickMs: nowMs(),
        status: 'active',
        result: null,
        ratingReported: false,
        pgn: chess.pgn(),
        fen: chess.fen(),
        moveCount: 0,
        lastMove: null,
      };
      await this.saveState(init);
      return ok({ initialized: true, gameId: init.gameId });
    }

    let st = await this.getState();
    if (!st) return err('Game not found', 404);

    // Tick clock on every interaction
    this.tick(st);

    // GET game state
    if (req.method === 'GET') {
      await this.saveState(st);
      return ok({ game: this.toPublic(st) });
    }

    // POST move / resign require auth token + invite
    if (req.method === 'POST') {
      const body = await readJson<{ agentToken?: string; move?: string; inviteCode?: string; action?: string }>(req);
      const okInv = await validateInvite(this.env, body.inviteCode);
      if (!okInv) return err('Invalid invite code', 401);

      // Determine which side caller is
      const lobbyId = this.env.LOBBY.idFromName('lobby');
      const lobbyStub = this.env.LOBBY.get(lobbyId);
      const lobbyStateResp = await lobbyStub.fetch('https://internal/agentLookup', {
        method: 'POST',
        body: JSON.stringify({ agentToken: body.agentToken }),
      });
      const lookup = await lobbyStateResp.json<any>();
      if (!lookup.success) return err('Unknown agent token', 401);
      const agentId = lookup.agent.agentId as string;

      const color: 'w' | 'b' | null = agentId === st.whiteAgentId ? 'w' : agentId === st.blackAgentId ? 'b' : null;
      if (!color) return err('Agent not in this game', 403);

      if (st.status !== 'active') return err('Game is not active', 409, { status: st.status, result: st.result });
      if (st.turn !== color) return err('Not your turn', 409, { turn: st.turn });

      const maybeReportRating = async () => {
        if (!st.result || st.ratingReported) return;
        try {
          const rid = this.env.RATINGS.idFromName('ratings');
          const rstub = this.env.RATINGS.get(rid);
          await rstub.fetch('https://x/report', {
            method: 'POST',
            body: JSON.stringify({
              gameId: st.gameId,
              endedAtMs: nowMs(),
              white: { agentId: st.whiteAgentId, name: st.whiteName },
              black: { agentId: st.blackAgentId, name: st.blackName },
              result: st.result,
            }),
          });
          st.ratingReported = true;
        } catch {
          // ignore transient failures
        }
      };

      if (body.action === 'resign') {
        st.status = 'resigned';
        st.result = color === 'w' ? '0-1' : '1-0';
        await maybeReportRating();
        await this.saveState(st);
        return ok({ game: this.toPublic(st) });
      }

      const uci = parseUci(body.move || '');
      if (!uci) return err('Invalid move format (use UCI like e2e4)', 400);

      const chess = new Chess(st.fen);
      const res = chess.move({ from: uci.from, to: uci.to, promotion: uci.promotion as any });
      if (!res) return err('Illegal move', 400);

      // Apply increment AFTER successful move
      if (color === 'w') st.whiteMs += st.incrementMs;
      else st.blackMs += st.incrementMs;

      st.fen = chess.fen();
      st.pgn = chess.pgn();
      st.turn = chess.turn();
      st.moveCount += 1;
      st.lastMove = `${uci.from}${uci.to}${uci.promotion || ''}`;

      // Update status if game over
      if (chess.isCheckmate()) {
        st.status = 'checkmate';
        st.result = st.turn === 'w' ? '1-0' : '0-1';
        await maybeReportRating();
      } else if (chess.isStalemate() || chess.isDraw()) {
        st.status = 'draw';
        st.result = '1/2-1/2';
        await maybeReportRating();
      }

      // Reset tick anchor
      st.lastTickMs = nowMs();

      await this.saveState(st);
      return ok({ game: this.toPublic(st) });
    }

    return err('Method not allowed', 405);
  }
}

// -----------------------------
// Internal endpoint on LobbyDO for agent lookup by token
// (keeps GameDO simple without duplicating registry)
// -----------------------------

// We intercept these in LobbyDO via fetch by hostname/internal path.
// Implemented by extending LobbyDO.fetch behavior here via a prototype patch.
// (Cloudflare DOs don't allow multiple handlers per file; keep it simple.)

const _LobbyFetch = LobbyDO.prototype.fetch;
LobbyDO.prototype.fetch = async function (req: Request): Promise<Response> {
  const url = new URL(req.url);
  if ((url.pathname === '/agentLookup' || url.hostname === 'internal') && req.method === 'POST') {
    const body = await readJson<{ agentToken?: string }>(req);
    const token = String(body.agentToken || '');
    if (!token) return err('Unknown agent token', 401);

    // Prefer KV-based lookup (no lobby state dependency)
    try {
      const rec = await (this as any).env.KV.get(`token:${token}`);
      if (rec) {
        const agent = JSON.parse(rec);
        return ok({ agent });
      }
    } catch {}

    // Backward-compat fallback to old in-DO agent registry
    const st = await (this as any).load();
    const agent = st.agents[token];
    if (!agent) return err('Unknown agent token', 401);
    agent.lastSeenMs = nowMs();
    st.agents[token] = agent;
    await (this as any).save(st);
    return ok({ agent });
  }
  return _LobbyFetch.call(this, req);
};

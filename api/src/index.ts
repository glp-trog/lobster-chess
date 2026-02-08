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
  whiteAgentId?: string;
  blackAgentId?: string;
  status: GameStatus;
  moveCount: number;
};

type LobbyState = {
  // token -> Agent record (used as the authoritative token registry)
  agents: Record<string, Agent>;

  // agentId -> basic identity (used for rendering + matchmaking heuristics)
  agentById: Record<string, { agentId: string; name: string; lastSeenMs?: number }>;

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
  const code = inviteCode.trim().toLowerCase();

  // Preferred: static public code for low-friction onboarding.
  // (Still keeps drive-by spam a little harder than totally open.)
  const staticCode = String((env as any).INVITE_STATIC || '').trim().toLowerCase();
  if (staticCode && code === staticCode) return true;

  // Backward compatible: daily rotating code derived from INVITE_SECRET.
  const today = await dailyInviteCode(env.INVITE_SECRET, yyyyMmDdUTC());
  if (code === today) return true;
  // allow previous day for clock skew / rollout
  const yesterdayDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const yesterday = await dailyInviteCode(env.INVITE_SECRET, yyyyMmDdUTC(yesterdayDate));
  return code === yesterday;
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

    // Register (LobbyDO storage)
    // NOTE: We intentionally avoid KV.put here because KV has daily write quotas.
    if (url.pathname === '/api/register' && req.method === 'POST') {
      const body = await readJson<{ inviteCode?: string; agentName?: string }>(req);
      const okInv = await validateInvite(env, body.inviteCode);
      if (!okInv) return err('Invalid invite code', 401);

      const name = (body.agentName || '').trim() || 'AnonymousAgent';
      const agentId = randomId('agent');
      const token = randomId('token');

      // Persist token->agent mapping in LobbyDO (Durable Object storage)
      const lobbyId = env.LOBBY.idFromName('lobby');
      const lobbyStub = env.LOBBY.get(lobbyId);
      await lobbyStub.fetch('https://internal/registerAgent', {
        method: 'POST',
        body: JSON.stringify({ agentId, name, agentToken: token }),
      });

      return ok({ agentId, agentToken: token, name });
    }

    // Heartbeat (LobbyDO storage) - best-effort
    if (url.pathname === '/api/heartbeat' && req.method === 'POST') {
      const body = await readJson<{ agentToken?: string }>(req);
      const token = String(body.agentToken || '');
      if (!token) return err('Missing agentToken', 400);

      const lobbyId = env.LOBBY.idFromName('lobby');
      const lobbyStub = env.LOBBY.get(lobbyId);
      const resp = await lobbyStub.fetch('https://internal/agentLookup', {
        method: 'POST',
        body: JSON.stringify({ agentToken: token }),
      });
      const j = await resp.json<any>();
      if (!j.success) return err('Unknown agent token', 401);
      return ok({ agentId: j.agent.agentId, name: j.agent.name });
    }

    // Admin: hard reset ratings/history
    if (url.pathname === '/api/admin/reset' && req.method === 'POST') {
      const admin = (req.headers.get('x-admin') || '').trim();
      const secret = String((env as any).ADMIN_SECRET || '').trim();
      if (!secret) return err('Admin reset not configured', 503);
      if (!admin || admin !== secret) return err('Unauthorized', 401);

      const rid = env.RATINGS.idFromName('ratings');
      const rstub = env.RATINGS.get(rid);
      // Hit DO internal reset path
      await rstub.fetch('https://x/reset', { method: 'POST' });
      return ok({ reset: true });
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
      if (!stored.agentById) stored.agentById = {};
      if (!stored.activeGameMeta) stored.activeGameMeta = {};
      return stored as LobbyState;
    }
    const init: LobbyState = { agents: {}, agentById: {}, waiting: [], waitingSinceMs: {}, activeGames: {}, activeGameMeta: {} };
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
        whiteAgentId: (white as any).agentId,
        blackAgentId: (black as any).agentId,
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

    if (req.method === 'GET' && path === '/api/queue/active') {
      const st = await this.load();
      const cutoff = nowMs() - 2 * 60 * 1000;
      const waiting = st.waiting.filter((aid) => (st.waitingSinceMs[aid] || 0) >= cutoff);
      // Keep state tidy
      if (waiting.length !== st.waiting.length) {
        st.waiting = waiting;
        await this.save(st);
      }

      const names = waiting
        .map((aid) => st.agentById[aid])
        .filter(Boolean)
        .map((a) => (a as any).name)
        .slice(0, 25);

      return ok({ waitingCount: waiting.length, waitingNames: names });
    }

    if (req.method === 'POST' && path === '/api/queue/join') {
      const gate = await requireInvite();
      if (gate) return gate;

      const body = await readJson<{ agentToken?: string; timeControl?: TimeControl }>(req);
      const token = String(body.agentToken || '');
      const tc = (body.timeControl || '3+2') as TimeControl;
      if (tc !== '3+2') return err('Only 3+2 supported for MVP', 400);

      const st = await this.load();

      // Resolve token via LobbyDO agent registry (Durable Object storage)
      const rec = st.agents[token];
      if (!rec) return err('Unknown agent token', 401);
      const agent: Agent = { agentId: rec.agentId, name: rec.name, token, lastSeenMs: nowMs() };
      rec.lastSeenMs = nowMs();
      st.agents[token] = rec;

      // If already in a game, return that (but clear stale mappings to finished games)
      const existing = st.activeGames[agent.agentId];
      if (existing) {
        try {
          const gid = this.env.GAME.idFromName(existing);
          const gstub = this.env.GAME.get(gid);
          const r = await gstub.fetch(`https://x/api/game/${encodeURIComponent(existing)}`);
          const j = (await r.json()) as any;
          const status = j?.game?.status;
          if (status === 'active') {
            await this.save(st);
            return ok({ status: 'matched', gameId: existing });
          }
        } catch {
          // fall through and clear mapping
        }
        delete st.activeGames[agent.agentId];
        await this.save(st);
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
        // Prefer matching agents with different display names to avoid confusing "X vs X" games.
        // (We can still fall back to same-name pairing if there is no alternative.)
        let otherIndex = 0;
        for (let i = 0; i < st.waiting.length; i++) {
          const candId = st.waiting[i];
          if (!candId || candId === agent.agentId) continue;
          const cand = st.agentById[candId];
          if (!cand) continue;
          if (String(cand.name || '').trim().toLowerCase() !== String(agent.name || '').trim().toLowerCase()) {
            otherIndex = i;
            break;
          }
        }

        const otherId = st.waiting.splice(otherIndex, 1)[0]!;
        delete st.waitingSinceMs[otherId];

        const otherRec = st.agentById[otherId];
        // If we can't resolve other, just requeue this agent
        if (!otherRec) {
          st.waiting.push(agent.agentId);
          st.waitingSinceMs[agent.agentId] = nowMs();
          await this.save(st);
          return ok({ status: 'waiting' });
        }
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
          whiteAgentId: white.agentId,
          blackAgentId: black.agentId,
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

      const st = await this.load();
      const rec = st.agents[token];
      if (!rec) return err('Unknown agent token', 401);

      // If enough agents are waiting, opportunistically match here too.
      // This makes matchmaking robust even if clients only call join once, then poll status.
      if (st.waiting.length >= 2) {
        const a = st.waiting[0];
        const b = st.waiting[1];
        if (a && b && a !== b) {
          // Try to resolve both agent records; if either is missing, drop it.
          const ar = st.agentById[a];
          const br = st.agentById[b];
          if (ar && br) {

            // If the first two have the same display name and there's an alternative waiting agent,
            // try to swap b with a different-name agent to avoid "X vs X".
            const an = String(ar.name || '').trim().toLowerCase();
            const bn = String(br.name || '').trim().toLowerCase();
            if (an && an === bn && st.waiting.length > 2) {
              for (let i = 2; i < st.waiting.length; i++) {
                const cid = st.waiting[i];
                const cr = st.agentById[cid];
                if (!cr) continue;
                const cn = String(cr.name || '').trim().toLowerCase();
                if (cn && cn !== an) {
                  // swap b with c
                  st.waiting[1] = cid;
                  st.waiting[i] = b;
                  // reload br to be c
                  br.agentId = cr.agentId;
                  br.name = cr.name;
                  break;
                }
              }
            }

            // remove the paired agents from waiting
            st.waiting.shift();
            st.waiting.shift();
            delete st.waitingSinceMs[a];
            delete st.waitingSinceMs[b];

            const gameIdNew = randomId('game');
            const whiteFirst = Math.random() < 0.5;
            const white = whiteFirst ? ar : br;
            const black = whiteFirst ? br : ar;

            st.activeGames[white.agentId] = gameIdNew;
            st.activeGames[black.agentId] = gameIdNew;
            st.activeGameMeta[gameIdNew] = {
              gameId: gameIdNew,
              createdAtMs: nowMs(),
              whiteName: white.name,
              blackName: black.name,
              status: 'active',
              moveCount: 0,
            };
            await this.save(st);

            // init game DO
            const gid = this.env.GAME.idFromName(gameIdNew);
            const gstub = this.env.GAME.get(gid);
            await gstub.fetch('https://internal/init', {
              method: 'POST',
              body: JSON.stringify({
                gameId: gameIdNew,
                whiteAgentId: white.agentId,
                blackAgentId: black.agentId,
                whiteName: white.name,
                blackName: black.name,
                timeControl: '3+2',
              }),
            });
          } else {
            // Drop missing entries to avoid deadlock.
            if (!ar) {
              st.waiting.shift();
              delete st.waitingSinceMs[a];
            }
            if (!br) {
              // b is now either still at index 0 or 1 depending on previous shift; just filter.
              st.waiting = st.waiting.filter((x) => x !== b);
              delete st.waitingSinceMs[b];
            }
            await this.save(st);
          }
        }
      }

      let gameId = st.activeGames[rec.agentId] || null;
      if (gameId) {
        // Clear stale activeGames mapping if the game is already finished.
        try {
          const gid = this.env.GAME.idFromName(gameId);
          const gstub = this.env.GAME.get(gid);
          const r = await gstub.fetch(`https://x/api/game/${encodeURIComponent(gameId)}`);
          const j = (await r.json()) as any;
          const status = j?.game?.status;
          if (status && status !== 'active') {
            delete st.activeGames[rec.agentId];
            gameId = null;
            await this.save(st);
          }
        } catch {
          // ignore
        }
      }

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

  // Internal: register agent token -> agent mapping.
  if ((url.hostname === 'internal' || url.hostname === 'x') && url.pathname === '/registerAgent' && req.method === 'POST') {
    const body = await readJson<{ agentId?: string; name?: string; agentToken?: string }>(req);
    const agentId = String(body.agentId || '');
    const name = String(body.name || '').trim() || 'AnonymousAgent';
    const token = String(body.agentToken || '');
    if (!agentId || !token) return err('Bad registerAgent payload', 400);

    const st = await (this as any).load();
    st.agents[token] = { agentId, name, token, lastSeenMs: nowMs() };
    st.agentById[agentId] = { agentId, name, lastSeenMs: nowMs() };
    await (this as any).save(st);
    return ok({ registered: true });
  }

  // Internal: lookup agent info by token.
  if ((url.pathname === '/agentLookup' || url.hostname === 'internal') && req.method === 'POST') {
    const body = await readJson<{ agentToken?: string }>(req);
    const token = String(body.agentToken || '');
    if (!token) return err('Unknown agent token', 401);

    const st = await (this as any).load();
    const agent = st.agents[token];
    if (!agent) return err('Unknown agent token', 401);

    // touch lastSeen
    agent.lastSeenMs = nowMs();
    st.agents[token] = agent;
    st.agentById[agent.agentId] = { agentId: agent.agentId, name: agent.name, lastSeenMs: agent.lastSeenMs };
    await (this as any).save(st);

    return ok({ agent: { agentId: agent.agentId, name: agent.name } });
  }

  return _LobbyFetch.call(this, req);
};

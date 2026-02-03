type Challenge = {
  id: string;
  createdAtMs: number;
  expiresAtMs: number;
  creator: { agentId: string; name: string };
  status: 'open' | 'accepted' | 'expired';
  acceptedBy?: { agentId: string; name: string };
  gameId?: string;
};

type ChallengeState = {
  challenges: Record<string, Challenge>;
};

function nowMs() {
  return Date.now();
}

function ok(obj: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ success: true, ...obj }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Invite',
    },
  });
}

function err(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ success: false, error: message, ...extra }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Invite',
    },
  });
}

async function readJson<T>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export class ChallengesDO {
  state: DurableObjectState;
  env: any;
  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  async load(): Promise<ChallengeState> {
    const stored = await this.state.storage.get<any>('state');
    if (stored) {
      if (!stored.challenges) stored.challenges = {};
      return stored as ChallengeState;
    }
    const init: ChallengeState = { challenges: {} };
    await this.state.storage.put('state', init);
    return init;
  }

  async save(st: ChallengeState) {
    await this.state.storage.put('state', st);
  }

  prune(st: ChallengeState) {
    const t = nowMs();
    for (const [id, c] of Object.entries(st.challenges)) {
      if (c.status === 'open' && c.expiresAtMs <= t) {
        c.status = 'expired';
        st.challenges[id] = c;
      }
    }
    // Hard cap
    const keys = Object.keys(st.challenges);
    if (keys.length > 2000) {
      keys.sort((a, b) => st.challenges[a].createdAtMs - st.challenges[b].createdAtMs);
      for (const k of keys.slice(0, keys.length - 2000)) delete st.challenges[k];
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return ok({ ok: true });

    const st = await this.load();
    this.prune(st);

    const path = url.pathname;

    // Helper: use LobbyDO to resolve agentToken -> agent info
    const lookupAgent = async (agentToken: string) => {
      const lobbyId = this.env.LOBBY.idFromName('lobby');
      const lobbyStub = this.env.LOBBY.get(lobbyId);
      const resp = await lobbyStub.fetch('https://internal/agentLookup', {
        method: 'POST',
        body: JSON.stringify({ agentToken }),
      });
      const j = await resp.json<any>();
      if (!j.success) throw new Error('Unknown agent token');
      return j.agent as { agentId: string; name: string };
    };

    if (req.method === 'POST' && path === '/api/challenge/create') {
      const body = await readJson<{ agentToken?: string }>(req);
      const token = String(body.agentToken || '');
      if (!token) return err('Missing agentToken', 400);

      let creator;
      try {
        creator = await lookupAgent(token);
      } catch {
        return err('Unknown agent token', 401);
      }

      const id = randomId('chal');
      const ttlMs = 15 * 60 * 1000;
      const c: Challenge = {
        id,
        createdAtMs: nowMs(),
        expiresAtMs: nowMs() + ttlMs,
        creator: { agentId: creator.agentId, name: creator.name },
        status: 'open',
      };

      st.challenges[id] = c;
      await this.save(st);
      return ok({ challengeId: id, expiresAtMs: c.expiresAtMs });
    }

    if (req.method === 'POST' && path === '/api/challenge/accept') {
      const body = await readJson<{ agentToken?: string; challengeId?: string }>(req);
      const token = String(body.agentToken || '');
      const cid = String(body.challengeId || '');
      if (!token) return err('Missing agentToken', 400);
      if (!cid) return err('Missing challengeId', 400);

      const c = st.challenges[cid];
      if (!c) return err('Challenge not found', 404);
      if (c.status !== 'open') return err('Challenge not open', 409, { status: c.status, gameId: c.gameId });
      if (c.expiresAtMs <= nowMs()) {
        c.status = 'expired';
        st.challenges[cid] = c;
        await this.save(st);
        return err('Challenge expired', 410);
      }

      let acceptor;
      try {
        acceptor = await lookupAgent(token);
      } catch {
        return err('Unknown agent token', 401);
      }

      if (acceptor.agentId === c.creator.agentId) return err('Cannot accept your own challenge', 400);

      const gameId = randomId('game');
      const whiteFirst = Math.random() < 0.5;
      const white = whiteFirst ? c.creator : acceptor;
      const black = whiteFirst ? acceptor : c.creator;

      // Create game state
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

      // Register in Lobby indices so /api/games/active works.
      try {
        const lobbyId = this.env.LOBBY.idFromName('lobby');
        const lobbyStub = this.env.LOBBY.get(lobbyId);
        await lobbyStub.fetch('https://x/challengeMatch', {
          method: 'POST',
          body: JSON.stringify({ gameId, white, black }),
        });
      } catch {
        // best-effort
      }

      c.status = 'accepted';
      c.acceptedBy = { agentId: acceptor.agentId, name: acceptor.name };
      c.gameId = gameId;
      st.challenges[cid] = c;
      await this.save(st);
      return ok({ gameId });
    }

    // GET /api/challenge?id=... (status)
    if (req.method === 'GET' && path === '/api/challenge') {
      const cid = url.searchParams.get('id') || '';
      const c = st.challenges[cid];
      if (!c) return err('Challenge not found', 404);
      return ok({ challenge: c });
    }

    await this.save(st);
    return err('Not found', 404);
  }
}

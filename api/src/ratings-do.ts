import { eloUpdate, parseResult, type GameResult, type RatingPlayer } from './ratings';

type RatingsState = {
  playersAll: Record<string, RatingPlayer>;
  games: GameResult[]; // append-only, pruned
  applied: Record<string, true>; // gameId -> applied
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
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function err(message: string, status = 400) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function defaultPlayer(agentId: string, name: string): RatingPlayer {
  return {
    agentId,
    name,
    rating: 1500,
    games: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    lastGameAtMs: null,
  };
}

function recordOutcome(p: RatingPlayer, s: number) {
  p.games += 1;
  if (s === 1) p.wins += 1;
  else if (s === 0) p.losses += 1;
  else p.draws += 1;
  p.lastGameAtMs = nowMs();
}

export class RatingsDO {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async reset() {
    const init: RatingsState = { playersAll: {}, games: [], applied: {} };
    await this.state.storage.put('state', init);
  }

  async load(): Promise<RatingsState> {
    const stored = await this.state.storage.get<any>('state');
    if (stored) {
      if (!stored.playersAll) stored.playersAll = {};
      if (!stored.games) stored.games = [];
      if (!stored.applied) stored.applied = {};
      return stored as RatingsState;
    }
    const init: RatingsState = { playersAll: {}, games: [], applied: {} };
    await this.state.storage.put('state', init);
    return init;
  }

  async save(st: RatingsState) {
    await this.state.storage.put('state', st);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return ok({ ok: true });

    const st = await this.load();

    // Admin reset: POST /reset (expects worker/router to auth this)
    if (req.method === 'POST' && (url.pathname === '/reset' || url.pathname === '/api/admin/reset')) {
      await this.reset();
      return ok({ reset: true });
    }

    // Internal report: POST /report
    if (req.method === 'POST' && (url.pathname === '/report' || url.hostname === 'x')) {
      const body = await req.json<any>();
      const parsed = parseResult(body.result);
      if (!parsed) return err('Bad result', 400);

      const gameId = String(body.gameId || '');
      if (!gameId) return err('Missing gameId', 400);
      if (st.applied[gameId]) return ok({ applied: false, reason: 'duplicate' });

      const g: GameResult = {
        gameId,
        endedAtMs: Number(body.endedAtMs || nowMs()),
        whiteId: String(body.white?.agentId || ''),
        whiteName: String(body.white?.name || 'White'),
        blackId: String(body.black?.agentId || ''),
        blackName: String(body.black?.name || 'Black'),
        result: body.result,
      };

      if (!g.whiteId || !g.blackId) return err('Missing player ids', 400);

      // Apply to all-time Elo
      const pW = st.playersAll[g.whiteId] || defaultPlayer(g.whiteId, g.whiteName);
      const pB = st.playersAll[g.blackId] || defaultPlayer(g.blackId, g.blackName);
      // Keep latest names
      pW.name = g.whiteName;
      pB.name = g.blackName;

      const k = 32;
      const newW = eloUpdate(pW.rating, pB.rating, parsed.sW, k);
      const newB = eloUpdate(pB.rating, pW.rating, parsed.sB, k);
      pW.rating = newW;
      pB.rating = newB;
      recordOutcome(pW, parsed.sW);
      recordOutcome(pB, parsed.sB);

      st.playersAll[g.whiteId] = pW;
      st.playersAll[g.blackId] = pB;

      st.games.push(g);
      st.applied[gameId] = true;

      // prune
      const maxGames = 5000;
      if (st.games.length > maxGames) st.games.splice(0, st.games.length - maxGames);

      // prune applied map if it gets too large
      const maxApplied = 10000;
      const appliedKeys = Object.keys(st.applied);
      if (appliedKeys.length > maxApplied) {
        // Keep applied markers for games we still have + the newest 2000
        const keep = new Set(st.games.map((x) => x.gameId));
        appliedKeys.sort();
        const tail = appliedKeys.slice(-2000);
        for (const k of tail) keep.add(k);
        const next: Record<string, true> = {};
        for (const k of keep) next[k] = true;
        st.applied = next;
      }

      await this.save(st);
      return ok({ applied: true });
    }

    // Public leaderboard: GET /api/leaderboard?scope=all|7d&limit=50
    if (req.method === 'GET') {
      const scope = (url.searchParams.get('scope') || 'all').toLowerCase();
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)));

      if (scope === 'all') {
        const players = Object.values(st.playersAll);
        players.sort((a, b) => b.rating - a.rating);
        return ok({ scope: 'all', players: players.slice(0, limit) });
      }

      if (scope === '7d') {
        const cutoff = nowMs() - 7 * 24 * 60 * 60 * 1000;
        const games = st.games.filter((g) => g.endedAtMs >= cutoff);

        // Recompute Elo just for games in window (start everyone at 1500)
        const players: Record<string, RatingPlayer> = {};

        for (const g of games) {
          const parsed = parseResult(g.result);
          if (!parsed) continue;

          const pW = players[g.whiteId] || defaultPlayer(g.whiteId, g.whiteName);
          const pB = players[g.blackId] || defaultPlayer(g.blackId, g.blackName);
          pW.name = g.whiteName;
          pB.name = g.blackName;

          const k = 32;
          const newW = eloUpdate(pW.rating, pB.rating, parsed.sW, k);
          const newB = eloUpdate(pB.rating, pW.rating, parsed.sB, k);
          pW.rating = newW;
          pB.rating = newB;
          recordOutcome(pW, parsed.sW);
          recordOutcome(pB, parsed.sB);

          players[g.whiteId] = pW;
          players[g.blackId] = pB;
        }

        const arr = Object.values(players);
        arr.sort((a, b) => b.rating - a.rating);
        return ok({ scope: '7d', players: arr.slice(0, limit), gamesInWindow: games.length });
      }

      return err('Invalid scope (use all or 7d)', 400);
    }

    return err('Not found', 404);
  }
}

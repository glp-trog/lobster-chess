import { Chess } from 'chess.js';

const API = (process.env.API_BASE || 'https://api.lobster-chess.com').trim().replace(/\/+$/,'');
const INVITE = process.env.INVITE_CODE;
const NAME = process.env.AGENT_NAME || `bot-${Math.random().toString(16).slice(2, 8)}`;
const THINK_MS = Number(process.env.THINK_MS || 250);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 15000);
const POLL_MS = Number(process.env.POLL_MS || 1200);

if (!INVITE) {
  console.error('Missing INVITE_CODE env var.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function post(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.success) throw new Error(`${path}: ${j.error || 'request failed'}`);
  return j;
}

async function get(path) {
  const r = await fetch(`${API}${path}`);
  const j = await r.json();
  if (!j.success) throw new Error(`${path}: ${j.error || 'request failed'}`);
  return j;
}

function toUci(move) {
  // chess.js returns { from, to, promotion? }
  return `${move.from}${move.to}${move.promotion || ''}`;
}

function pickMove(chess) {
  // MVP: random legal move
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  const m = moves[Math.floor(Math.random() * moves.length)];
  return toUci(m);
}

async function main() {
  console.log(`[lobster-chess bot] API=${API}`);
  console.log(`[lobster-chess bot] NAME=${NAME}`);

  const reg = await post('/api/register', { inviteCode: INVITE, agentName: NAME });
  const token = reg.agentToken;
  const agentId = reg.agentId;
  console.log(`[lobster-chess bot] registered agentId=${agentId}`);

  // heartbeat loop
  (async () => {
    while (true) {
      try {
        await post('/api/heartbeat', { agentToken: token });
      } catch (e) {
        // non-fatal
      }
      await sleep(HEARTBEAT_MS);
    }
  })();

  // join loop
  let gameId = null;
  while (!gameId) {
    const j = await post('/api/queue/join', { inviteCode: INVITE, agentToken: token, timeControl: '3+2' });
    if (j.status === 'matched' && j.gameId) {
      gameId = j.gameId;
      break;
    }
    process.stdout.write('.');
    await sleep(2000);
  }
  console.log(`\n[lobster-chess bot] matched gameId=${gameId}`);

  let lastMoveCount = -1;

  while (true) {
    const g = await get(`/api/game/${encodeURIComponent(gameId)}`);
    const game = g.game;

    if (game.moveCount !== lastMoveCount) {
      lastMoveCount = game.moveCount;
      console.log(`[game] moves=${game.moveCount} turn=${game.turn} status=${game.status} result=${game.result || ''}`);
      console.log(`[clock] W=${Math.round(game.white.ms/1000)}s B=${Math.round(game.black.ms/1000)}s`);
    }

    if (game.status !== 'active') {
      console.log(`[lobster-chess bot] game over: ${game.status} ${game.result || ''}`);
      process.exit(0);
    }

    const myColor = agentId === game.white.agentId ? 'w' : agentId === game.black.agentId ? 'b' : null;
    if (!myColor) throw new Error('Agent is not a participant in this game (unexpected)');

    if (game.turn === myColor) {
      // think and move
      await sleep(THINK_MS);

      const chess = new Chess(game.fen);
      const uci = pickMove(chess);
      if (!uci) {
        console.log('[lobster-chess bot] no legal moves');
        await sleep(POLL_MS);
        continue;
      }

      try {
        const res = await post(`/api/game/${encodeURIComponent(gameId)}/move`, { inviteCode: INVITE, agentToken: token, move: uci });
        const ng = res.game;
        console.log(`[move] ${myColor}: ${uci} -> turn=${ng.turn} moves=${ng.moveCount}`);
      } catch (e) {
        console.log(`[move] failed (${uci}): ${e.message}`);
        // usually stale turn/race; just retry next poll
      }
    }

    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

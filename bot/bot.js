import { Chess } from 'chess.js';
import stockfish from 'stockfish';

const API = (process.env.API_BASE || 'https://api.lobster-chess.com').trim().replace(/\/+$/, '');
const INVITE = process.env.INVITE_CODE;
const NAME = process.env.AGENT_NAME || `bot-${Math.random().toString(16).slice(2, 8)}`;

const ENGINE_MOVETIME_MS = Number(process.env.ENGINE_MOVETIME_MS || 250);
const ENGINE_DEPTH = process.env.ENGINE_DEPTH ? Number(process.env.ENGINE_DEPTH) : null;

const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 15000);
const POLL_MS = Number(process.env.POLL_MS || 900);

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

// -----------------------------
// Stockfish (UCI)
// -----------------------------

function createEngine() {
  const sf = stockfish();
  const listeners = new Set();

  const onLine = (line) => {
    for (const fn of listeners) fn(line);
  };

  // stockfish package supports either .onmessage (worker-like) or event callback
  if (typeof sf === 'function') {
    // some builds expose a function you call with commands and it returns lines via callbacks
    // but stockfish() in this package returns a Worker-like interface in most environments.
  }

  if (sf && typeof sf.addEventListener === 'function') {
    sf.addEventListener('message', (e) => onLine(String(e.data)));
  } else if (sf && 'onmessage' in sf) {
    sf.onmessage = (e) => onLine(String(e.data));
  }

  const send = (cmd) => {
    if (sf && typeof sf.postMessage === 'function') sf.postMessage(cmd);
    else if (typeof sf === 'function') sf(cmd);
    else throw new Error('Unsupported stockfish interface');
  };

  const waitFor = (predicate, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const fn = (line) => {
        if (predicate(line)) {
          listeners.delete(fn);
          resolve(line);
        } else if (Date.now() - t0 > timeoutMs) {
          listeners.delete(fn);
          reject(new Error('Engine timeout'));
        }
      };
      listeners.add(fn);
    });

  const init = async () => {
    send('uci');
    await waitFor((l) => l === 'uciok', 8000);
    send('isready');
    await waitFor((l) => l === 'readyok', 8000);
    // stronger + faster defaults
    send('setoption name Threads value 1');
    send('setoption name Hash value 64');
    send('ucinewgame');
    send('isready');
    await waitFor((l) => l === 'readyok', 8000);
  };

  const bestMove = async (fen) => {
    send(`position fen ${fen}`);
    if (ENGINE_DEPTH && Number.isFinite(ENGINE_DEPTH)) {
      send(`go depth ${ENGINE_DEPTH}`);
    } else {
      send(`go movetime ${ENGINE_MOVETIME_MS}`);
    }
    const line = await waitFor((l) => l.startsWith('bestmove '), 15000);
    const parts = line.split(' ');
    const mv = parts[1];
    if (!mv || mv === '(none)') return null;
    return mv.trim();
  };

  return { init, bestMove };
}

function randomLegalUci(fen) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;
  const m = moves[Math.floor(Math.random() * moves.length)];
  return `${m.from}${m.to}${m.promotion || ''}`.toLowerCase();
}

function isLegalUci(fen, uci) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  return moves.some((m) => `${m.from}${m.to}${m.promotion || ''}`.toLowerCase() === uci.toLowerCase());
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

  // init engine once
  const engine = createEngine();
  await engine.init();
  console.log(`[lobster-chess bot] engine ready (${ENGINE_DEPTH ? `depth ${ENGINE_DEPTH}` : `movetime ${ENGINE_MOVETIME_MS}ms`})`);

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
      let uci = null;
      try {
        uci = await engine.bestMove(game.fen);
      } catch (e) {
        console.log(`[engine] error: ${e.message}`);
      }

      if (!uci || !isLegalUci(game.fen, uci)) {
        const fallback = randomLegalUci(game.fen);
        if (!fallback) {
          console.log('[lobster-chess bot] no legal moves');
          await sleep(POLL_MS);
          continue;
        }
        uci = fallback;
      }

      try {
        const res = await post(`/api/game/${encodeURIComponent(gameId)}/move`, { inviteCode: INVITE, agentToken: token, move: uci });
        const ng = res.game;
        console.log(`[move] ${myColor}: ${uci} -> turn=${ng.turn} moves=${ng.moveCount}`);
      } catch (e) {
        console.log(`[move] failed (${uci}): ${e.message}`);
      }
    }

    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

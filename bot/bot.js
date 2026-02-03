import { Chess } from 'chess.js';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
// Use the stockfish package assets, but run it as a separate Node process (UCI over stdin/stdout).
const ENGINE_JS = require.resolve('stockfish/src/stockfish-17.1-lite-single-03e3232.js');

const API = (process.env.API_BASE || 'https://api.lobster-chess.com').trim().replace(/\/+$/, '');
const INVITE = process.env.INVITE_CODE;
const NAME = process.env.AGENT_NAME || `bot-${Math.random().toString(16).slice(2, 8)}`;

const ENGINE_MOVETIME_MS = Number(process.env.ENGINE_MOVETIME_MS || 250);
const ENGINE_DEPTH = process.env.ENGINE_DEPTH ? Number(process.env.ENGINE_DEPTH) : null;

const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 30000);
// Increase default polling to avoid Cloudflare Durable Objects free-tier rate limits.
const POLL_MS = Number(process.env.POLL_MS || 2000);

if (!INVITE) {
  console.error('Missing INVITE_CODE env var.');
  process.exit(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isDoVolumeError(text) {
  const s = String(text || '').toLowerCase();
  return s.includes('error code: 1101') || s.includes('worker threw exception') || s.includes('exceeded allowed volume');
}

async function readJsonOrThrow(r, pathForErr) {
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const text = await r.text();
  try {
    const j = JSON.parse(text);
    if (!j.success) throw new Error(`${pathForErr}: ${j.error || 'request failed'}`);
    return j;
  } catch (e) {
    const preview = String(text || '').slice(0, 180).replace(/\s+/g, ' ');
    const extra = isDoVolumeError(text) ? ' (Cloudflare DO limit hit; back off and retry)' : '';
    const err = new Error(`${pathForErr}: non-JSON response (status ${r.status}, ct=${ct}) :: ${preview}${extra}`);
    err._raw = text;
    err._status = r.status;
    throw err;
  }
}

async function post(path, body) {
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return await readJsonOrThrow(r, path);
}

async function get(path) {
  const r = await fetch(`${API}${path}`);
  return await readJsonOrThrow(r, path);
}

// -----------------------------
// Stockfish (UCI)
// -----------------------------

function createEngine() {
  const proc = spawn(process.execPath, [ENGINE_JS], { stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdin.setDefaultEncoding('utf8');

  const listeners = new Set();
  const onLine = (line) => {
    const s = String(line).trim();
    if (!s) return;
    for (const fn of listeners) fn(s);
  };

  const wire = (stream) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      while (true) {
        const idx = buf.indexOf('\n');
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        onLine(line);
      }
    });
  };

  wire(proc.stdout);
  wire(proc.stderr);

  const send = (cmd) => {
    proc.stdin.write(cmd + '\n');
  };

  const waitFor = (predicate, timeoutMs = 8000) =>
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
    await waitFor((l) => l === 'uciok');
    send('isready');
    await waitFor((l) => l === 'readyok');
    send('setoption name Threads value 1');
    send('setoption name Hash value 64');
    send('ucinewgame');
    send('isready');
    await waitFor((l) => l === 'readyok');
  };

  const bestMove = async (fen) => {
    let latestScoreCp = null;

    const scoreListener = (line) => {
      // Example: info depth 10 score cp 23 ...
      // Example: info depth 12 score mate 3 ...
      const m = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)\b/i);
      if (!m) return;
      const kind = m[1].toLowerCase();
      const val = Number(m[2]);
      if (!Number.isFinite(val)) return;
      if (kind === 'cp') latestScoreCp = val;
      else {
        // Mate scores: convert to a large cp-equivalent for our decision logic.
        const sign = val === 0 ? 1 : Math.sign(val);
        latestScoreCp = sign * 100000;
      }
    };

    listeners.add(scoreListener);

    send(`position fen ${fen}`);
    if (ENGINE_DEPTH && Number.isFinite(ENGINE_DEPTH)) send(`go depth ${ENGINE_DEPTH}`);
    else send(`go movetime ${ENGINE_MOVETIME_MS}`);

    const line = await waitFor((l) => l.startsWith('bestmove '), 15000);
    listeners.delete(scoreListener);

    const parts = line.split(' ');
    const mv = parts[1];
    if (!mv || mv === '(none)') return { move: null, scoreCp: latestScoreCp };
    return { move: mv.trim(), scoreCp: latestScoreCp };
  };

  const quit = () => {
    try { send('quit'); } catch {}
    try { proc.kill(); } catch {}
  };

  return { init, bestMove, quit };
}

function fenKey(fen) {
  // Repetition key: placement + side + castling + en-passant
  const parts = String(fen || '').trim().split(/\s+/);
  return parts.slice(0, 4).join(' ');
}

function uciToMoveObj(uci) {
  const s = String(uci || '').trim().toLowerCase();
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(s)) return null;
  return { from: s.slice(0, 2), to: s.slice(2, 4), promotion: s[4] };
}

function applyUciToFen(fen, uci) {
  const chess = new Chess(fen);
  const m = uciToMoveObj(uci);
  if (!m) return null;
  const res = chess.move({ from: m.from, to: m.to, promotion: m.promotion });
  if (!res) return null;
  return chess.fen();
}

function randomLegalUci(fen, avoidKeys = null) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  if (!moves.length) return null;

  // Shuffle moves for randomness
  for (let i = moves.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [moves[i], moves[j]] = [moves[j], moves[i]];
  }

  for (const m of moves) {
    const uci = `${m.from}${m.to}${m.promotion || ''}`.toLowerCase();
    if (!avoidKeys) return uci;
    const nf = applyUciToFen(fen, uci);
    if (!nf) continue;
    if (!avoidKeys.has(fenKey(nf))) return uci;
  }

  // If everything repeats, fall back to first legal move
  const m = moves[0];
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

  // Persist identity per-machine per-agent-name.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const stateDir = path.join(process.cwd(), '.state');
  const statePath = path.join(stateDir, `${NAME.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);

  let token = null;
  let agentId = null;

  try {
    if (fs.existsSync(statePath)) {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      token = saved.agentToken || null;
      agentId = saved.agentId || null;
    }
  } catch {}

  if (token) {
    // Validate token with a heartbeat; if invalid, re-register.
    try {
      const hb = await post('/api/heartbeat', { agentToken: token });
      agentId = hb.agentId || agentId;
      console.log(`[lobster-chess bot] reused agentId=${agentId}`);
    } catch {
      token = null;
      agentId = null;
    }
  }

  if (!token) {
    const reg = await post('/api/register', { inviteCode: INVITE, agentName: NAME });
    token = reg.agentToken;
    agentId = reg.agentId;
    console.log(`[lobster-chess bot] registered agentId=${agentId}`);
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ agentName: NAME, agentId, agentToken: token }, null, 2));
      console.log(`[lobster-chess bot] saved identity to ${statePath}`);
    } catch {}
  }

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

  const EXIT_AFTER_ONE = (process.env.EXIT_AFTER_ONE || '').trim() === '1';
  console.log(`[lobster-chess bot] mode=${EXIT_AFTER_ONE ? 'one-game' : 'always-queue'}`);

  while (true) {
    // join queue ONCE, then check status periodically (avoids hammering DOs)
    let gameId = null;

    try {
      const j = await post('/api/queue/join', { inviteCode: INVITE, agentToken: token, timeControl: '3+2' });
      if (j.status === 'matched' && j.gameId) gameId = j.gameId;
    } catch (e) {
      console.log(String(e.message || e));
      // If DO quota is tripped, back off hard.
      await sleep(60000);
      continue;
    }

    while (!gameId) {
      process.stdout.write('.');
      // queue/status is cheaper than re-joining
      try {
        const s = await get(`/api/queue/status?agentToken=${encodeURIComponent(token)}`);
        if (s.status === 'matched' && s.gameId) {
          gameId = s.gameId;
          break;
        }
      } catch (e) {
        console.log(`\n${String(e.message || e)}`);
        if (String(e.message || e).includes('DO limit')) {
          await sleep(60000);
        }
      }
      await sleep(5000);
    }

    console.log(`\n[lobster-chess bot] matched gameId=${gameId}`);

    let lastMoveCount = -1;
    const seen = new Map(); // fenKey -> count

    while (true) {
      const g = await get(`/api/game/${encodeURIComponent(gameId)}`);
      const game = g.game;

    // Track repetition keys
    const keyNow = fenKey(game.fen);
    seen.set(keyNow, (seen.get(keyNow) || 0) + 1);

    if (game.moveCount !== lastMoveCount) {
      lastMoveCount = game.moveCount;
      console.log(`[game] moves=${game.moveCount} turn=${game.turn} status=${game.status} result=${game.result || ''}`);
      console.log(`[clock] W=${Math.round(game.white.ms/1000)}s B=${Math.round(game.black.ms/1000)}s`);
    }

    if (game.status !== 'active') {
      console.log(`[lobster-chess bot] game over: ${game.status} ${game.result || ''}`);
      break;
    }

    const myColor = agentId === game.white.agentId ? 'w' : agentId === game.black.agentId ? 'b' : null;
    if (!myColor) throw new Error('Agent is not a participant in this game (unexpected)');

    if (game.turn === myColor) {
      let uci = null;
      let scoreCp = null;

      try {
        const bm = await engine.bestMove(game.fen);
        uci = bm.move;
        scoreCp = bm.scoreCp;
      } catch (e) {
        console.log(`[engine] error: ${e.message}`);
      }

      if (!uci || !isLegalUci(game.fen, uci)) {
        uci = randomLegalUci(game.fen, new Set(seen.keys()));
      }

      // Avoid trivial repetition unless we're doing badly.
      const avoidThresholdCp = -50; // allow repeats if worse than this
      try {
        const nextFen = applyUciToFen(game.fen, uci);
        const nextKey = nextFen ? fenKey(nextFen) : null;
        const wouldRepeat = nextKey ? seen.has(nextKey) : false;
        if (wouldRepeat && (scoreCp === null || scoreCp >= avoidThresholdCp)) {
          const alt = randomLegalUci(game.fen, new Set(seen.keys()));
          if (alt && alt !== uci) {
            console.log(`[repetition] avoiding repeat (scoreCp=${scoreCp ?? 'n/a'}) using alt=${alt}`);
            uci = alt;
          }
        }
      } catch {}

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
      }
    }

    await sleep(POLL_MS);
  }

    if (EXIT_AFTER_ONE) process.exit(0);
    // tiny pause before re-queue to avoid thrashing
    await sleep(1000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

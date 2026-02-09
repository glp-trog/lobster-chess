// agent-loop.mjs
//
// Purpose: "direct" OpenClaw-agent play loop.
// - polls game state
// - when it's our turn, prints a compact prompt (FEN + legal moves)
// - reads a single UCI move from stdin
// - submits it
//
// This is intentionally minimal; it lets an LLM (OpenClaw agent) choose moves.

import { Chess } from 'chess.js';

const API = process.env.API_BASE || 'https://api.lobster-chess.com';
const INVITE = process.env.INVITE_CODE;
const NAME = process.env.AGENT_NAME || 'OpenClawAgent';

if (!INVITE) {
  console.error('Missing INVITE_CODE env var');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function readJsonOrThrow(r, where) {
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const raw = await r.text();
  if (!ct.includes('application/json')) {
    throw new Error(`${where}: non-JSON response (status ${r.status}) :: ${raw.slice(0, 200).replace(/\s+/g,' ')}`);
  }
  let j;
  try { j = JSON.parse(raw); } catch {
    throw new Error(`${where}: JSON parse error (status ${r.status}) :: ${raw.slice(0, 200).replace(/\s+/g,' ')}`);
  }
  if (!j.success) throw new Error(`${where}: ${j.error || 'request failed'}`);
  return j;
}

async function post(path, body) {
  const r = await fetch(`${API}${path}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  return await readJsonOrThrow(r, path);
}

async function get(path) {
  const r = await fetch(`${API}${path}`);
  return await readJsonOrThrow(r, path);
}

function uciListFromFen(fen) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  return moves.map(m => `${m.from}${m.to}${m.promotion || ''}`);
}

function readLine() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (data) => resolve(String(data).trim()));
  });
}

function isUci(s) {
  return /^[a-h][1-8][a-h][1-8][qrbn]?$/.test((s || '').trim().toLowerCase());
}

async function main() {
  const reg = await post('/api/register', { inviteCode: INVITE, agentName: NAME });
  const token = reg.agentToken;
  const agentId = reg.agentId;
  console.log(`[registered] agentId=${agentId}`);

  let gameId = null;
  while (!gameId) {
    const j = await post('/api/queue/join', { inviteCode: INVITE, agentToken: token, timeControl: '3+2' });
    if (j.status === 'matched' && j.gameId) gameId = j.gameId;
    else await sleep(1500);
  }
  console.log(`[matched] gameId=${gameId}`);

  while (true) {
    const g = await get(`/api/game/${encodeURIComponent(gameId)}`);
    const game = g.game;
    if (game.status !== 'active') {
      console.log(`[game-over] ${game.status} ${game.result || ''}`);
      process.exit(0);
    }

    const myColor = agentId === game.white.agentId ? 'w' : agentId === game.black.agentId ? 'b' : null;
    if (!myColor) throw new Error('Not a participant in game');

    if (game.turn !== myColor) {
      await sleep(900);
      continue;
    }

    const legal = uciListFromFen(game.fen);

    console.log('\n=== YOUR TURN ===');
    console.log(`You are: ${myColor === 'w' ? 'WHITE' : 'BLACK'}`);
    console.log(`FEN: ${game.fen}`);
    console.log(`Clocks: W ${Math.round(game.white.ms/1000)}s | B ${Math.round(game.black.ms/1000)}s (+${Math.round(game.incrementMs/1000)}s)`);
    console.log(`Legal moves (${legal.length}): ${legal.join(' ')}`);
    console.log('Reply with exactly ONE UCI move (e.g., e2e4).');

    const move = (await readLine()).toLowerCase();
    if (!isUci(move) || !legal.includes(move)) {
      console.log(`[reject] invalid or illegal move: ${move}`);
      continue;
    }

    try {
      const res = await post(`/api/game/${encodeURIComponent(gameId)}/move`, { inviteCode: INVITE, agentToken: token, move });
      console.log(`[played] ${move} -> moves=${res.game.moveCount} turn=${res.game.turn}`);
    } catch (e) {
      // Race conditions happen (clock tick / turn flip). Don't crash; just retry loop.
      const msg = String(e && e.message ? e.message : e);
      if (msg.includes('Not your turn')) {
        console.log(`[race] ${msg}`);
        await sleep(600);
        continue;
      }
      console.error(e);
      await sleep(1000);
      continue;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

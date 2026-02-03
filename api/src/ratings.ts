export type RatingPlayer = {
  agentId: string;
  name: string;
  rating: number;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  lastGameAtMs: number | null;
};

export type GameResult = {
  gameId: string;
  endedAtMs: number;
  whiteId: string;
  whiteName: string;
  blackId: string;
  blackName: string;
  result: '1-0' | '0-1' | '1/2-1/2';
};

export function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export function expectedScore(rA: number, rB: number) {
  return 1 / (1 + 10 ** ((rB - rA) / 400));
}

export function eloUpdate(rA: number, rB: number, sA: number, k = 32) {
  const eA = expectedScore(rA, rB);
  return rA + k * (sA - eA);
}

export function parseResult(result: string): { sW: number; sB: number } | null {
  const r = (result || '').trim();
  if (r === '1-0') return { sW: 1, sB: 0 };
  if (r === '0-1') return { sW: 0, sB: 1 };
  if (r === '1/2-1/2') return { sW: 0.5, sB: 0.5 };
  return null;
}

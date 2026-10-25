import type { Address } from 'viem';
import type { AirnodeV2Request } from './airnode-v2.ts';

export const PANDASCORE_AIRNODE_DIRECT_URL = 'https://airnode-pandascore.fly.dev/';

// Where calls go. PANDASCORE_AIRNODE_URL can point at `pnpm priced-airnode` to rehearse paying over x402. The signer
// check below does not change, so whatever answers must pass on the real Airnode's signed responses.
export const PANDASCORE_AIRNODE_URL = process.env.PANDASCORE_AIRNODE_URL ?? PANDASCORE_AIRNODE_DIRECT_URL;

// The address that the PandaScore Airnode signs with, from the x-airnode extension of the document at its URL.
export const PANDASCORE_AIRNODE_ADDRESS: Address = '0xd9D29FEDc3737aD5198611457fE04aB08a739C7b';

// The request whose signed responses settle a market on `matchId`. The projection cuts PandaScore's match object down
// to the four fields that EsportsMarket.settle reads, so the request hash fixes both the match and those fields.
export const buildResultRequest = (matchId: number | bigint): AirnodeV2Request => ({
  operation: 'getMatch',
  parameters: { match_id_or_slug: String(matchId) },
  responseProjection: {
    status: '/status',
    winnerId: '/winner_id',
    teamA: '/opponents/0/opponent/id',
    teamB: '/opponents/1/opponent/id',
  },
});

export interface MatchSummary {
  id: number;
  name: string;
  status: string;
  beginAt: string | null;
  league: string | null;
  videogame: string | null;
  teams: { id: number; name: string }[];
  winnerId: number | null;
}

interface PandaScoreMatch {
  id: number;
  name: string;
  status: string;
  begin_at: string | null;
  scheduled_at: string | null;
  winner_id: number | null;
  league?: { name?: string } | null;
  videogame?: { name?: string } | null;
  opponents?: { opponent?: { id: number; name: string } }[];
}

const summarize = (match: PandaScoreMatch): MatchSummary => ({
  id: match.id,
  name: match.name,
  status: match.status,
  beginAt: match.begin_at ?? match.scheduled_at,
  league: match.league?.name ?? null,
  videogame: match.videogame?.name ?? null,
  teams: (match.opponents ?? []).flatMap(({ opponent }) =>
    opponent ? [{ id: opponent.id, name: opponent.name }] : []
  ),
  winnerId: match.winner_id,
});

// Reads match details for people and agents to choose from. Nothing here goes on-chain, so the signature that comes
// with these responses is not checked. All teams share the upstream quota, so keep `perPage` small and cache results.
const callUnsigned = async (operation: string, parameters: Record<string, unknown>) => {
  const response = await fetch(PANDASCORE_AIRNODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, parameters }),
  });
  if (!response.ok) throw new Error(`The Airnode responded with ${response.status}: ${await response.text()}`);
  return ((await response.json()) as { data: unknown }).data;
};

export const listMatches = async (when: 'upcoming' | 'past' | 'running', perPage = 10): Promise<MatchSummary[]> => {
  const operation = { upcoming: 'matchesUpcoming', past: 'matchesPast', running: 'matchesRunning' }[when];
  const matches = (await callUnsigned(operation, { per_page: perPage })) as PandaScoreMatch[];
  return matches.map(summarize);
};

export const getMatch = async (matchId: number | bigint): Promise<MatchSummary> =>
  summarize((await callUnsigned('getMatch', { match_id_or_slug: String(matchId) })) as PandaScoreMatch);

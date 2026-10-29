import { listMatches } from './pandascore.ts';
import { createScriptFetch } from './x402.ts';

// Lists PandaScore matches to open markets on: pnpm find-matches [upcoming|running|past] [count]
// The call is paid over x402.
const when = (process.argv[2] ?? 'upcoming') as 'upcoming' | 'running' | 'past';
if (!['upcoming', 'running', 'past'].includes(when))
  throw new Error('Usage: pnpm find-matches [upcoming|running|past] [count]');
const count = Number(process.argv[3] ?? 10);

for (const match of await listMatches(when, count, createScriptFetch())) {
  const teams = match.teams.map(({ id, name }) => `${name} (${id})`).join(' vs ') || 'teams not set yet';
  const winner = match.winnerId ? `  winner ${match.winnerId}` : '';
  console.log(`${match.id}  ${match.beginAt ?? 'no date'}  ${match.status.padEnd(11)} ${match.videogame ?? ''}`);
  console.log(`         ${teams}${winner}`);
  console.log(`         ${match.league ?? ''} · ${match.name}\n`);
}

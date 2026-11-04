import { useEffect, useState } from 'react';
import { api, type HistoryEntry, type Me } from './api';
import { useAction } from './useAction';

export function HistoryPage({ me }: { me: Me }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const { busy, error, run } = useAction();
  const teamNames = new Map(me.teams.map((team) => [team.teamId, team.name]));

  const loadMore = (from: string | null | undefined) =>
    run(async () => {
      const page = await api.history(from);
      setEntries((current) => (from ? [...current, ...page.checkins] : page.checkins));
      setCursor(page.nextCursor);
    });
  useEffect(() => {
    void loadMore(undefined);
  }, []);

  return (
    <section className="card">
      <h2>My check-ins</h2>
      {error && <p className="error-text">{error}</p>}
      {cursor !== undefined && entries.length === 0 && <p className="muted">No check-ins yet.</p>}
      {entries.map((entry) => (
        <article key={`${entry.date}-${entry.teamId}`} className="entry">
          <h4>
            {entry.date}{' '}
            <span className="muted small">{teamNames.get(entry.teamId) ?? 'Former team'}</span>
          </h4>
          <ul className="list">
            {entry.answers.filter(Boolean).map((answer, index) => (
              <li key={index}>{answer}</li>
            ))}
          </ul>
          {entry.blocker && <p className="blocker">Blocker: {entry.blocker}</p>}
        </article>
      ))}
      {cursor && (
        <div className="row">
          <button className="secondary" disabled={busy} onClick={() => loadMore(cursor)}>
            Load more
          </button>
        </div>
      )}
    </section>
  );
}

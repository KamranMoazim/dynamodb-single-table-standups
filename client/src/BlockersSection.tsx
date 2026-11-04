import { useEffect, useState } from 'react';
import { api, type Blocker } from './api';
import { useAction } from './useAction';

export function BlockersSection({
  teamId,
  canResolve,
  version,
  onChanged,
}: {
  teamId: string;
  canResolve: boolean;
  version: number;
  onChanged: () => void;
}) {
  const [blockers, setBlockers] = useState<Blocker[] | null>(null);
  const { busy, error, run } = useAction();

  const load = () => run(async () => setBlockers((await api.blockers(teamId)).blockers));
  useEffect(() => {
    void load();
  }, [teamId, version]);

  return (
    <section className="card">
      <h3>Open blockers</h3>
      {error && <p className="error-text">{error}</p>}
      {blockers?.length === 0 && <p className="muted">Nothing blocked.</p>}
      <ul className="list">
        {blockers?.map((blocker) => (
          <li key={`${blocker.date}-${blocker.userId}`} className="spread">
            <span>
              <strong>{blocker.authorName}</strong> {blocker.blocker}{' '}
              <span className="muted small">{blocker.date}</span>
            </span>
            {canResolve && (
              <button
                className="secondary small"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api.resolveBlocker(teamId, blocker.date, blocker.userId);
                    setBlockers((current) => current?.filter((item) => item !== blocker) ?? null);
                    onChanged();
                  })
                }
              >
                Resolve
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

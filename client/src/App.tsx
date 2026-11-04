import { useEffect, useState } from 'react';
import { apiCall, type Health } from './api';

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiCall<Health>('GET', '/health')
      .then(setHealth)
      .catch((caught: Error) => setError(caught.message));
  }, []);

  return (
    <main>
      <h1>StandupLog</h1>
      <p className="muted">Async standups on one DynamoDB table.</p>
      <section className={`card ${error ? 'error' : health ? 'ok' : ''}`}>
        <h2>Backend</h2>
        {error && <p>{error}</p>}
        {!error && !health && <p className="muted">Checking...</p>}
        {health && (
          <dl>
            <dt>Table</dt>
            <dd>{health.table.name}</dd>
            <dt>Status</dt>
            <dd>{health.table.status}</dd>
            <dt>Indexes</dt>
            <dd>{health.table.indexes.join(', ')}</dd>
          </dl>
        )}
      </section>
    </main>
  );
}

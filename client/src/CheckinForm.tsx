import { useEffect, useState, type FormEvent } from 'react';
import { api, type Checkin, type Team } from './api';
import { useAction } from './useAction';

export function CheckinForm({ team, onSaved }: { team: Team; onSaved: () => void }) {
  const [existing, setExisting] = useState<Checkin | null | undefined>(undefined);
  const [date, setDate] = useState('');
  const [answers, setAnswers] = useState(['', '', '']);
  const [blocker, setBlocker] = useState('');
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction();

  useEffect(() => {
    void run(async () => {
      const today = await api.todayCheckin(team.teamId);
      setDate(today.date);
      setExisting(today.checkin);
      if (today.checkin) {
        setAnswers(today.checkin.answers);
        setBlocker(today.checkin.blocker ?? '');
      }
    });
  }, [team.teamId]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const input = { answers, blocker: blocker.trim() || null };
      const { checkin } = existing
        ? await api.editCheckin(team.teamId, input)
        : await api.submitCheckin(team.teamId, input);
      setExisting(checkin);
      setEditing(false);
      onSaved();
    });
  }

  if (existing === undefined) {
    return <p className={error ? 'error-text' : 'muted'}>{error ?? 'Loading your check-in...'}</p>;
  }
  if (existing && !editing) {
    return (
      <div className="spread">
        <span>Checked in for {date}.</span>
        <button className="secondary small" onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <p className="muted small">Your check-in for {date}</p>
      {team.questions.map((question, index) => (
        <label key={index}>
          {question}
          <textarea
            maxLength={1000}
            rows={2}
            value={answers[index]}
            onChange={(event) => {
              const next = [...answers];
              next[index] = event.target.value;
              setAnswers(next);
            }}
          />
        </label>
      ))}
      <label>
        Blocked on something? (optional, shows in open blockers)
        <input
          maxLength={500}
          value={blocker}
          onChange={(event) => setBlocker(event.target.value)}
        />
      </label>
      {error && <p className="error-text">{error}</p>}
      <div className="row">
        <button disabled={busy || answers.every((answer) => !answer.trim())}>
          {existing ? 'Save changes' : 'Post check-in'}
        </button>
        {existing && (
          <button type="button" className="secondary" onClick={() => setEditing(false)}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

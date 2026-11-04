import { useEffect, useState, type FormEvent } from 'react';
import { api, type Me, type TeamConfig, type TeamView } from './api';
import { BlockersSection } from './BlockersSection';
import { CheckinForm } from './CheckinForm';
import { FeedSection } from './FeedSection';
import { useAction } from './useAction';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const REMINDER_TIMES = Array.from({ length: 96 }, (_, index) => {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(index / 4))}:${pad((index % 4) * 15)}`;
});

function ConfigForm({
  teamId,
  initial,
  onSaved,
}: {
  teamId: string;
  initial: TeamConfig;
  onSaved: () => void;
}) {
  const [config, setConfig] = useState(initial);
  const { busy, error, run } = useAction();

  function toggleDay(day: number) {
    const workdays = config.workdays.includes(day)
      ? config.workdays.filter((existing) => existing !== day)
      : [...config.workdays, day];
    setConfig({ ...config, workdays });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await api.saveTeamConfig(teamId, config);
      onSaved();
    });
  }

  return (
    <form onSubmit={submit}>
      {config.questions.map((question, index) => (
        <label key={index}>
          Question {index + 1}
          <input
            required
            maxLength={200}
            value={question}
            onChange={(event) => {
              const questions = [...config.questions];
              questions[index] = event.target.value;
              setConfig({ ...config, questions });
            }}
          />
        </label>
      ))}
      <fieldset className="days">
        <legend>Workdays</legend>
        {DAY_NAMES.map((name, day) => (
          <label key={day} className="inline">
            <input
              type="checkbox"
              checked={config.workdays.includes(day)}
              onChange={() => toggleDay(day)}
            />
            {name}
          </label>
        ))}
      </fieldset>
      <label>
        Reminder time (each member's local time)
        <select
          value={config.reminderTime}
          onChange={(event) => setConfig({ ...config, reminderTime: event.target.value })}
        >
          {REMINDER_TIMES.map((time) => (
            <option key={time}>{time}</option>
          ))}
        </select>
      </label>
      {error && <p className="error-text">{error}</p>}
      <div className="row">
        <button disabled={busy || config.workdays.length === 0}>Save config</button>
      </div>
    </form>
  );
}

export function TeamPage({
  teamId,
  me,
  onChanged,
}: {
  teamId: string;
  me: Me;
  onChanged: () => void;
}) {
  const [view, setView] = useState<TeamView | null>(null);
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((current) => current + 1);
  const load = useAction();
  const action = useAction();

  const refresh = () => load.run(async () => setView(await api.team(teamId)));
  useEffect(() => {
    void refresh();
  }, [teamId]);

  if (!view) {
    return <p className={load.error ? 'error-text' : 'muted'}>{load.error ?? 'Loading...'}</p>;
  }
  const { team, members, role } = view;
  const myStats = members.find((member) => member.userId === me.userId);
  const isMember = myStats !== undefined;

  const changeMembership = (change: () => Promise<unknown>) =>
    action.run(async () => {
      await change();
      onChanged();
      await refresh();
    });

  return (
    <>
      <p className="muted">
        <a href={`#/w/${team.workspaceId}`}>Back to workspace</a>
      </p>
      <h2 className="page-title">{team.name}</h2>
      {isMember && (
        <section className="card">
          <h3>
            Today
            {myStats && myStats.streak > 0 && (
              <span className="badge">{myStats.streak} day streak</span>
            )}
          </h3>
          <CheckinForm
            team={team}
            onSaved={() => {
              bump();
              setTimeout(() => void refresh(), 3000);
            }}
          />
        </section>
      )}
      <FeedSection team={team} myUserId={me.userId} version={version} />
      <BlockersSection
        teamId={teamId}
        canResolve={isMember || role === 'owner'}
        version={version}
        onChanged={bump}
      />
      <section className="card">
        <h3>Standup settings</h3>
        {role === 'owner' ? (
          <ConfigForm key={JSON.stringify(team)} teamId={teamId} initial={team} onSaved={refresh} />
        ) : (
          <dl>
            {team.questions.map((question, index) => (
              <div key={index} className="contents">
                <dt>Q{index + 1}</dt>
                <dd>{question}</dd>
              </div>
            ))}
            <dt>Days</dt>
            <dd>{team.workdays.map((day) => DAY_NAMES[day]).join(', ')}</dd>
            <dt>Reminder</dt>
            <dd>{team.reminderTime} local time</dd>
          </dl>
        )}
      </section>
      <section className="card">
        <h3>Members</h3>
        <ul className="list">
          {members.map((member) => (
            <li key={member.userId} className="spread">
              <span>
                {member.name} <span className="muted small">{member.timezone}</span>
                {member.streak > 0 && (
                  <span
                    className="badge"
                    title={`Longest ${member.longestStreak}, ${member.total} check-ins`}
                  >
                    {member.streak} day streak
                  </span>
                )}
              </span>
              {(member.userId === me.userId || role === 'owner') && (
                <button
                  className="secondary small"
                  disabled={action.busy}
                  onClick={() =>
                    changeMembership(() => api.removeTeamMember(teamId, member.userId))
                  }
                >
                  {member.userId === me.userId ? 'Leave' : 'Remove'}
                </button>
              )}
            </li>
          ))}
        </ul>
        {!isMember && (
          <div className="row">
            <button
              disabled={action.busy}
              onClick={() => changeMembership(() => api.joinTeam(teamId))}
            >
              Join team
            </button>
          </div>
        )}
        {action.error && <p className="error-text">{action.error}</p>}
      </section>
    </>
  );
}

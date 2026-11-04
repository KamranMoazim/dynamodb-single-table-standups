import { useEffect, useState, type FormEvent } from 'react';
import { api, type Me, type WorkspaceView } from './api';
import { useAction } from './useAction';

export function WorkspacePage({
  workspaceId,
  me,
  onChanged,
}: {
  workspaceId: string;
  me: Me;
  onChanged: () => void;
}) {
  const [view, setView] = useState<WorkspaceView | null>(null);
  const [teamName, setTeamName] = useState('');
  const load = useAction();
  const action = useAction();

  const refresh = () => load.run(async () => setView(await api.workspace(workspaceId)));
  useEffect(() => {
    void refresh();
  }, [workspaceId]);

  if (!view) {
    return <p className={load.error ? 'error-text' : 'muted'}>{load.error ?? 'Loading...'}</p>;
  }
  const isOwner = view.workspace.ownerId === me.userId;
  const myTeamIds = new Set(me.teams.map((team) => team.teamId));

  function createTeam(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      const { team } = await api.createTeam(workspaceId, teamName);
      setTeamName('');
      onChanged();
      window.location.hash = `#/t/${team.teamId}`;
    });
  }

  return (
    <>
      <h2 className="page-title">{view.workspace.name}</h2>
      <section className="card">
        <h3>Invite people</h3>
        <p>
          Share this code: <code className="code">{view.workspace.inviteCode}</code>
        </p>
      </section>
      <section className="card">
        <h3>Teams</h3>
        {view.teams.length === 0 && <p className="muted">No teams yet.</p>}
        <ul className="list">
          {view.teams.map((team) => (
            <li key={team.teamId} className="spread">
              <a href={`#/t/${team.teamId}`}>{team.name}</a>
              {myTeamIds.has(team.teamId) ? (
                <span className="badge">joined</span>
              ) : (
                <button
                  className="secondary small"
                  disabled={action.busy}
                  onClick={() =>
                    action.run(async () => {
                      await api.joinTeam(team.teamId);
                      onChanged();
                    })
                  }
                >
                  Join
                </button>
              )}
            </li>
          ))}
        </ul>
        {isOwner && (
          <form className="row" onSubmit={createTeam}>
            <input
              required
              maxLength={80}
              placeholder="New team name"
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
            />
            <button disabled={action.busy}>Create team</button>
          </form>
        )}
        {action.error && <p className="error-text">{action.error}</p>}
      </section>
      <section className="card">
        <h3>Members</h3>
        <ul className="list">
          {view.members.map((member) => (
            <li key={member.userId}>
              {member.name}
              <span className="badge">{member.role}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

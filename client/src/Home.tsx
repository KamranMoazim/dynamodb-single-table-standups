import { useState, type FormEvent } from 'react';
import { api, type Me } from './api';
import { useAction } from './useAction';

export function Home({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [workspaceName, setWorkspaceName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const create = useAction();
  const join = useAction();

  function createWorkspace(event: FormEvent) {
    event.preventDefault();
    void create.run(async () => {
      const { workspace } = await api.createWorkspace(workspaceName);
      onChanged();
      window.location.hash = `#/w/${workspace.workspaceId}`;
    });
  }

  function joinWorkspace(event: FormEvent) {
    event.preventDefault();
    void join.run(async () => {
      const { workspace } = await api.joinWorkspace(inviteCode);
      onChanged();
      window.location.hash = `#/w/${workspace.workspaceId}`;
    });
  }

  return (
    <>
      <section className="card">
        <h2>Your workspaces</h2>
        {me.workspaces.length === 0 && (
          <p className="muted">None yet. Create one or join with an invite code.</p>
        )}
        <ul className="list">
          {me.workspaces.map((workspace) => (
            <li key={workspace.workspaceId}>
              <a href={`#/w/${workspace.workspaceId}`}>{workspace.name}</a>
              <span className="badge">{workspace.role}</span>
              <ul className="list nested">
                {me.teams
                  .filter((team) => team.workspaceId === workspace.workspaceId)
                  .map((team) => (
                    <li key={team.teamId}>
                      <a href={`#/t/${team.teamId}`}>{team.name}</a>
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
      <div className="split">
        <form className="card" onSubmit={createWorkspace}>
          <h2>New workspace</h2>
          <label>
            Name
            <input
              required
              maxLength={80}
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
            />
          </label>
          {create.error && <p className="error-text">{create.error}</p>}
          <div className="row">
            <button disabled={create.busy}>Create</button>
          </div>
        </form>
        <form className="card" onSubmit={joinWorkspace}>
          <h2>Join a workspace</h2>
          <label>
            Invite code
            <input
              required
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
            />
          </label>
          {join.error && <p className="error-text">{join.error}</p>}
          <div className="row">
            <button disabled={join.busy}>Join</button>
          </div>
        </form>
      </div>
    </>
  );
}

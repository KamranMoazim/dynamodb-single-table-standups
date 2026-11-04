import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { AuthScreen } from './AuthScreen';
import { currentSession, signOut } from './auth';
import { Home } from './Home';
import { ProfileForm } from './ProfileForm';
import { useHashRoute } from './route';
import { TeamPage } from './TeamPage';
import { WorkspacePage } from './WorkspacePage';

export function App() {
  const [signedIn, setSignedIn] = useState(() => currentSession() !== null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const route = useHashRoute();

  const loadMe = () =>
    api
      .me()
      .then(setMe)
      .catch((caught: Error) => {
        if (caught instanceof ApiError && caught.status === 401) {
          signOut();
          setSignedIn(false);
          return;
        }
        setError(caught.message);
      });

  useEffect(() => {
    if (signedIn) {
      void loadMe();
    }
  }, [signedIn]);

  if (!signedIn) {
    return <AuthScreen onSignedIn={() => setSignedIn(true)} />;
  }
  if (!me) {
    return (
      <main>
        {error ? <p className="error-text">{error}</p> : <p className="muted">Loading...</p>}
      </main>
    );
  }

  return (
    <main>
      <header className="spread">
        <h1>
          <a href="#/">StandupLog</a>
        </h1>
        <nav className="row tight">
          <a href="#/profile">{me.profile?.name ?? me.email}</a>
          <button
            className="secondary small"
            onClick={() => {
              signOut();
              setMe(null);
              setSignedIn(false);
            }}
          >
            Sign out
          </button>
        </nav>
      </header>
      {!me.profile || route.page === 'profile' ? (
        <ProfileForm
          profile={me.profile}
          onSaved={() => {
            void loadMe();
            window.location.hash = '#/';
          }}
        />
      ) : route.page === 'workspace' ? (
        <WorkspacePage workspaceId={route.workspaceId} me={me} onChanged={loadMe} />
      ) : route.page === 'team' ? (
        <TeamPage teamId={route.teamId} me={me} onChanged={loadMe} />
      ) : (
        <Home me={me} onChanged={loadMe} />
      )}
    </main>
  );
}

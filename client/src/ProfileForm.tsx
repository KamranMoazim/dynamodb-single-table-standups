import { useState, type FormEvent } from 'react';
import { api, type Profile } from './api';
import { useAction } from './useAction';

const TIME_ZONES = Intl.supportedValuesOf('timeZone');

export function ProfileForm({
  profile,
  onSaved,
}: {
  profile: Profile | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState(profile?.name ?? '');
  const [timezone, setTimezone] = useState(
    profile?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const { busy, error, run } = useAction();

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await api.saveProfile({ name, timezone });
      onSaved();
    });
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>{profile ? 'Your profile' : 'Welcome! Tell your team who you are'}</h2>
      <label>
        Name
        <input
          required
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        Timezone
        <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
          {TIME_ZONES.map((zone) => (
            <option key={zone}>{zone}</option>
          ))}
        </select>
      </label>
      <p className="muted small">Reminders arrive at your team's reminder time in this timezone.</p>
      {error && <p className="error-text">{error}</p>}
      <div className="row">
        <button disabled={busy}>Save</button>
      </div>
    </form>
  );
}

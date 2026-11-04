import { useEffect, useState, type FormEvent } from 'react';
import { api, type Feed, type FeedEntry, type Team } from './api';
import { useAction } from './useAction';

export const EMOJI: Record<string, string> = {
  thumbsup: '\u{1F44D}',
  tada: '\u{1F389}',
  eyes: '\u{1F440}',
  heart: '\u{2764}\u{FE0F}',
  pray: '\u{1F64F}',
};

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function Entry({
  team,
  entry,
  myUserId,
  onChanged,
}: {
  team: Team;
  entry: FeedEntry;
  myUserId: string;
  onChanged: () => void;
}) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();

  function comment(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      await api.comment(team.teamId, entry.date, entry.userId, text);
      setText('');
      onChanged();
    });
  }

  return (
    <article className="entry">
      <h4>{entry.authorName}</h4>
      <dl>
        {team.questions.map((question, index) =>
          entry.answers[index] ? (
            <div key={index} className="contents">
              <dt>{question}</dt>
              <dd>{entry.answers[index]}</dd>
            </div>
          ) : null,
        )}
      </dl>
      {entry.blocker && (
        <p className={`blocker ${entry.blockerResolvedBy ? 'resolved' : ''}`}>
          Blocker: {entry.blocker}
          {entry.blockerResolvedBy && ' (resolved)'}
        </p>
      )}
      <div className="reactions">
        {Object.entries(EMOJI).map(([name, glyph]) => {
          const people = entry.reactions[name] ?? [];
          const mine = people.some((person) => person.userId === myUserId);
          return (
            <button
              key={name}
              className={`reaction ${mine ? 'mine' : ''}`}
              title={people.map((person) => person.name).join(', ') || name}
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.react(team.teamId, entry.date, entry.userId, name, !mine);
                  onChanged();
                })
              }
            >
              {glyph} {people.length > 0 && people.length}
            </button>
          );
        })}
      </div>
      {entry.comments.length > 0 && (
        <ul className="comments">
          {entry.comments.map((item) => (
            <li key={item.commentId}>
              <strong>{item.byName}</strong> {item.text}
            </li>
          ))}
        </ul>
      )}
      <form className="row" onSubmit={comment}>
        <input
          maxLength={500}
          placeholder="Comment"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button className="secondary small" disabled={busy || !text.trim()}>
          Reply
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
    </article>
  );
}

export function FeedSection({
  team,
  myUserId,
  version,
}: {
  team: Team;
  myUserId: string;
  version: number;
}) {
  const [date, setDate] = useState<string | undefined>(undefined);
  const [feed, setFeed] = useState<Feed | null>(null);
  const { error, run } = useAction();

  const load = () => run(async () => setFeed(await api.feed(team.teamId, date)));
  useEffect(() => {
    void load();
  }, [team.teamId, date, version]);

  return (
    <section className="card">
      <div className="spread">
        <h3>Feed {feed && <span className="muted small">{feed.date}</span>}</h3>
        {feed && (
          <div className="row tight">
            <button className="secondary small" onClick={() => setDate(shiftDate(feed.date, -1))}>
              Previous day
            </button>
            <button className="secondary small" onClick={() => setDate(shiftDate(feed.date, 1))}>
              Next day
            </button>
          </div>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
      {!feed && !error && <p className="muted">Loading...</p>}
      {feed && (
        <>
          {!feed.isWorkday && <p className="muted small">Not a standup day for this team.</p>}
          {feed.checkins.length === 0 && <p className="muted">No check-ins for this day.</p>}
          {feed.checkins.map((entry) => (
            <Entry
              key={entry.userId}
              team={team}
              entry={entry}
              myUserId={myUserId}
              onChanged={load}
            />
          ))}
          {feed.missing.length > 0 && (
            <p className="muted small">
              Not posted yet: {feed.missing.map((member) => member.name).join(', ')}
            </p>
          )}
        </>
      )}
    </section>
  );
}

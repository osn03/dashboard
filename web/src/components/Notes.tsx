import { useState } from 'react';
import { formatDate, instantToZoned } from '../../../shared/dates';
import { useActions, useNotes } from '../api';
import { useEnv } from '../env';

/** Dated notes attached to one task or one project. */
export function AttachedNotes({ taskId, projectId }: { taskId?: string; projectId?: string }) {
  const notes = useNotes();
  const actions = useActions();
  const { tz } = useEnv();
  const [text, setText] = useState('');
  const mine = (notes.data ?? []).filter((n) => (taskId ? n.taskId === taskId : n.projectId === projectId));
  const add = () => {
    const body = text.trim();
    if (!body) return;
    void actions.createNote(body, taskId ?? null, projectId ?? null).then((ok) => ok && setText(''));
  };
  return (
    <div className="attached-notes">
      {notes.isError && <p className="form-error">Could not load notes.</p>}
      {mine.length === 0 && !notes.isLoading && <p className="hint">No notes yet.</p>}
      <ul className="note-list dated">
        {mine.map((n) => (
          <li key={n.id}>
            <div>
              <span className="muted small">{formatDate(instantToZoned(n.createdAt, tz).date)}</span>
              <p>{n.body}</p>
            </div>
            <button type="button" className="icon-btn" aria-label="Delete note" onClick={() => void actions.deleteNote(n.id)}>×</button>
          </li>
        ))}
      </ul>
      <div className="inline-add">
        <textarea
          rows={2}
          value={text}
          placeholder={taskId ? 'Add a note to this task…' : 'Add a note to this project…'}
          aria-label={taskId ? 'New note for this task' : 'New note for this project'}
          maxLength={20000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn small" onClick={add} disabled={!text.trim()}>Add note</button>
      </div>
    </div>
  );
}

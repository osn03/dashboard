import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { formatTime } from '../../../shared/dates';
import { MAX_CHAT_IMAGES, type AssistantAction } from '../../../shared/types';
import { api, useActions, useAssistantActions, useAssistantHistory, useAssistantStatus } from '../api';
import { useEnv } from '../env';
import { canCaptureScreen, captureScreen, prepareImage, type Attachment } from '../images';
import { useUI } from '../ui';

const EXAMPLES = [
  'Plan tomorrow around my meetings and training.',
  'Add a task to renew my passport by Friday.',
  'Find a 90-minute slot for focused work this week.',
  'Move my unfinished tasks to tomorrow, but keep their deadlines.',
  'Which tasks have I been neglecting?',
];
const STATUS_LABEL: Record<AssistantAction['status'], string> = {
  proposed: 'Waiting for you', executed: 'Done', failed: 'Failed', rejected: 'Rejected', undone: 'Undone',
};

/** Reads a server-sent event stream from a fetch response. */
async function readEvents(res: Response, on: (event: string, data: any) => void): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) on(event, JSON.parse(data));
    }
  }
}

export function AssistantPanel({ onClose }: { onClose: () => void }) {
  const status = useAssistantStatus();
  const actionsQ = useAssistantActions(true);
  const historyQ = useAssistantHistory();
  const actions = useActions();
  const qc = useQueryClient();
  const { tz, settings } = useEnv();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<{ user: string; images: string[]; reply: string; steps: string[]; notices: string[] } | null>(null);
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [dropping, setDropping] = useState(false);
  const { toast } = useUI();
  const fileInput = useRef<HTMLInputElement>(null);
  const [deciding, setDeciding] = useState('');
  const [tab, setTab] = useState<'chat' | 'history'>('chat');
  const abort = useRef<AbortController | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);
  /** True while the reader is at (or near) the newest message; only then does the view follow new content. */
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const byId = new Map((actionsQ.data ?? []).map((a) => [a.id, a]));
  const turns = historyQ.data ?? [];

  const toBottom = () => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  const lastTop = useRef(0);
  const onScroll = () => {
    const el = body.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    // Stop following only when the reader actually moved up. New content makes the list taller
    // without moving the scroll position, so a scroll event that arrives just after content was
    // added must not be mistaken for the reader scrolling away.
    const movedUp = el.scrollTop < lastTop.current - 1;
    lastTop.current = el.scrollTop;
    if (near) stick.current = true;
    else if (movedUp) stick.current = false;
    setAway(!stick.current);
  };
  // Follow new content only while the reader is at the bottom. Watching the size of the message
  // list (rather than specific state) covers streaming text, cards that grow when confirmed,
  // images that finish loading, and the panel or input area changing size.
  useEffect(() => {
    const list = log.current;
    const box = body.current;
    if (!list || !box) return;
    stick.current = true;
    setAway(false);
    toBottom();
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom();
    });
    ro.observe(list);
    ro.observe(box);
    return () => ro.disconnect();
  }, [tab]);
  useEffect(() => {
    input.current?.focus();
  }, []);

  /** Adds pasted, dropped, chosen or captured images (up to the per-message limit). */
  async function attach(files: (Blob & { name?: string })[]) {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;
    const room = MAX_CHAT_IMAGES - attached.length;
    if (images.length > room) toast(`Up to ${MAX_CHAT_IMAGES} images per message.`, { kind: 'error' });
    const added: Attachment[] = [];
    for (const f of images.slice(0, Math.max(0, room))) {
      try {
        added.push(await prepareImage(f, f.name || 'Pasted image'));
      } catch (e) {
        toast(e instanceof Error ? e.message : 'That image could not be added.', { kind: 'error' });
      }
    }
    if (added.length) setAttached((a) => [...a, ...added].slice(0, MAX_CHAT_IMAGES));
  }
  const detach = (i: number) =>
    setAttached((a) => {
      URL.revokeObjectURL(a[i].url);
      return a.filter((_, j) => j !== i);
    });

  async function send(message: string) {
    const body = message.trim();
    const images = attached;
    if ((!body && !images.length) || pending) return;
    setText('');
    stick.current = true; // sending always brings the newest message into view
    setAway(false);
    setAttached([]);
    setPending({ user: body || 'Please look at the attached image.', images: images.map((i) => i.url), reply: '', steps: [], notices: [] });
    const ac = new AbortController();
    abort.current = ac;
    try {
      const res = await fetch('/api/assistant/send', {
        method: 'POST', credentials: 'same-origin', signal: ac.signal,
        headers: { 'content-type': 'application/json', 'x-requested-with': 'dashboard' },
        body: JSON.stringify({ text: body, images: images.map(({ mediaType, data }) => ({ mediaType, data })) }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error ?? `The assistant could not be reached (${res.status}).`);
      }
      await readEvents(res, (event, data) => {
        if (event === 'delta') setPending((p) => p && { ...p, reply: p.reply + data.text });
        else if (event === 'tool') setPending((p) => p && { ...p, steps: [...p.steps, `${data.ok ? 'Looked up' : 'Could not use'}: ${String(data.name).replaceAll('_', ' ')}`] });
        else if (event === 'notice') setPending((p) => p && { ...p, notices: [...p.notices, data.text] });
      });
    } catch {
      /* Stopped by the user, or the connection dropped. The server records what happened; the stored history shows it. */
    }
    abort.current = null;
    await qc.invalidateQueries({ queryKey: ['assistant'] });
    images.forEach((i) => URL.revokeObjectURL(i.url));
    setPending(null);
  }

  const decide = async (a: AssistantAction, what: 'confirm' | 'reject' | 'undo') => {
    setDeciding(a.id);
    await actions.assistantDecide(a.id, what, a.digest);
    setDeciding('');
  };

  const card = (a: AssistantAction) => (
    <div key={a.id} className={`proposal ${a.status}`} data-testid="proposal">
      <div className="proposal-head">
        <strong>{a.summary}</strong>
        <span className={`badge ${a.status === 'failed' ? 'danger' : a.status === 'proposed' ? 'warn' : 'subtle'}`}>{STATUS_LABEL[a.status]}</span>
      </div>
      {a.external && <p className="proposal-ext">Changes Google Calendar</p>}
      {a.details.length > 0 && <ul className="proposal-details">{a.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
      {a.result && <p className={a.status === 'failed' ? 'form-error' : 'proposal-result'}>{a.result}</p>}
      {a.status === 'proposed' && (
        <div className="btn-group">
          <button className="btn primary small" disabled={!!deciding} onClick={() => void decide(a, 'confirm')}>{deciding === a.id ? 'Working…' : 'Confirm'}</button>
          <button className="btn small" disabled={!!deciding} onClick={() => void decide(a, 'reject')}>Reject</button>
        </div>
      )}
      {a.canUndo && <button className="btn small" disabled={!!deciding} onClick={() => void decide(a, 'undo')}>Undo</button>}
      {a.status === 'executed' && !a.canUndo && <p className="hint">This cannot be undone from here.</p>}
    </div>
  );

  const st = status.data;
  const ready = st?.state === 'ready';
  return (
    <aside
      className={`assistant-panel${dropping ? ' dropping' : ''}`}
      aria-label="Assistant"
      onDragOver={(e) => {
        if (ready && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        if (!ready) return;
        e.preventDefault();
        setDropping(false);
        void attach([...e.dataTransfer.files]);
      }}
    >
      <header className="assistant-head">
        <h2>Assistant</h2>
        <div className="segmented" role="radiogroup" aria-label="Assistant view">
          {(['chat', 'history'] as const).map((t) => (
            <label key={t} className={tab === t ? 'on' : ''}>
              <input type="radio" name="assistant-tab" checked={tab === t} onChange={() => setTab(t)} />
              {t === 'chat' ? 'Chat' : 'Action history'}
            </label>
          ))}
        </div>
        <button className="icon-btn" aria-label="Close assistant" onClick={onClose}>×</button>
      </header>

      {tab === 'history' ? (
        <div className="assistant-body" ref={body}>
          <div className="chat-log" ref={log}>
            {(actionsQ.data ?? []).length === 0 ? <p className="empty">No actions yet. Everything the assistant proposes is listed here with its outcome.</p> : null}
            {(actionsQ.data ?? []).map((a) => (
              <div key={a.id} className="msg">
                <p className="muted small">{a.createdAt.slice(0, 10)} {formatTime(a.createdAt, tz, settings.hour12)}</p>
                {card(a)}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="assistant-body" ref={body} onScroll={onScroll} data-testid="chat-scroll">
            <div className="chat-log" ref={log} aria-live="polite" data-testid="chat-log">
            {st?.state === 'demo' && <p className="banner">The assistant is switched off in demo mode.</p>}
            {st?.state === 'not_configured' && (
              <div className="card">
                <h3>{st.providerName} is not ready</h3>
                <p>{st.message}</p>
                <p className="hint">The assistant is optional — everything else works without it. See <Link to="/settings" onClick={onClose}>Settings → Assistant</Link> for status and setup.</p>
              </div>
            )}
            {ready && turns.length === 0 && !pending && (
              <div>
                <p className="muted">Ask about your day or week, or ask for changes. Nothing is changed until you confirm it.</p>
                <ul className="examples">
                  {EXAMPLES.map((e) => (
                    <li key={e}><button className="btn small" onClick={() => void send(e)}>{e}</button></li>
                  ))}
                </ul>
              </div>
            )}
            {turns.map((t) => {
              const mine = t.proposalIds.map((id) => byId.get(id)).filter((a): a is AssistantAction => !!a);
              const open = mine.filter((a) => a.status === 'proposed');
              return (
                <div key={t.id} className={`msg msg-${t.role}${t.error ? ' msg-error' : ''}`} data-role={t.role}>
                  {t.imageIds.length > 0 && (
                    <div className="thumbs">
                      {t.imageIds.map((id) => (
                        <a key={id} href={`/api/assistant/images/${id}`} target="_blank" rel="noopener noreferrer" title="Open image">
                          <img src={`/api/assistant/images/${id}`} alt="Attached image" loading="lazy" />
                        </a>
                      ))}
                    </div>
                  )}
                  <p>{t.text}</p>
                  {mine.map(card)}
                  {open.length > 1 && (
                    <button className="btn small" disabled={!!deciding} onClick={async () => { for (const a of open) await decide(a, 'confirm'); }}>Confirm all</button>
                  )}
                </div>
              );
            })}
            {pending && (
              <>
                <div className="msg msg-user" data-role="user">
                  {pending.images.length > 0 && <div className="thumbs">{pending.images.map((u) => <img key={u} src={u} alt="Attached image" />)}</div>}
                  <p>{pending.user}</p>
                </div>
                <div className="msg msg-assistant" data-role="assistant" data-testid="streaming">
                  {pending.notices.map((n, i) => <p key={i} className="banner">{n}</p>)}
                  {pending.steps.map((s, i) => <p key={i} className="muted small">{s}</p>)}
                  <p>{pending.reply || 'Thinking…'}</p>
                </div>
              </>
            )}
            </div>
          </div>
          {away && (
            <button
              type="button"
              className="btn small jump-latest"
              onClick={() => {
                stick.current = true;
                setAway(false);
                toBottom();
              }}
            >
              ↓ Jump to latest
            </button>
          )}
          {ready && (
            <div className="assistant-attach">
              {attached.length > 0 && (
                <div className="thumbs" aria-label="Images to send">
                  {attached.map((a, i) => (
                    <span key={a.url} className="thumb">
                      <img src={a.url} alt={a.name} />
                      <button type="button" className="icon-btn" aria-label={`Remove ${a.name}`} onClick={() => detach(i)}>×</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="btn-group">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  multiple
                  hidden
                  aria-label="Choose images to attach"
                  onChange={(e) => {
                    void attach([...(e.target.files ?? [])]);
                    e.target.value = '';
                  }}
                />
                <button type="button" className="btn small ghost" disabled={!!pending || attached.length >= MAX_CHAT_IMAGES} onClick={() => fileInput.current?.click()}>Attach image</button>
                {canCaptureScreen() && (
                  <button
                    type="button"
                    className="btn small ghost"
                    disabled={!!pending || attached.length >= MAX_CHAT_IMAGES}
                    title="Pick a window, tab or screen in the browser's chooser; one still picture is taken"
                    onClick={() =>
                      void captureScreen()
                        .then((a) => a && setAttached((cur) => [...cur, a].slice(0, MAX_CHAT_IMAGES)))
                        .catch((e) => toast(e instanceof Error ? e.message : 'The screen could not be captured.', { kind: 'error' }))
                    }
                  >
                    Capture screen
                  </button>
                )}
                <span className="muted small">or paste / drop a screenshot</span>
              </div>
            </div>
          )}
          {ready && (
            <form
              className="assistant-input"
              onSubmit={(e) => {
                e.preventDefault();
                void send(text);
              }}
            >
              <textarea
                ref={input}
                rows={2}
                value={text}
                placeholder="Ask or tell the assistant…"
                aria-label="Message to the assistant"
                maxLength={8000}
                onChange={(e) => setText(e.target.value)}
                onPaste={(e) => {
                  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
                  if (files.length) {
                    e.preventDefault(); // a pasted screenshot becomes an attachment, not text
                    void attach(files);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send(text);
                  }
                }}
              />
              {pending ? (
                <button className="btn" type="button" onClick={() => abort.current?.abort()}>Stop</button>
              ) : (
                <button className="btn primary" type="submit" disabled={!text.trim() && attached.length === 0}>Send</button>
              )}
            </form>
          )}
          {st && st.state !== 'demo' && (
            <p className="hint assistant-foot">
              {st.providerName} · {st.model}. {st.billing === 'subscription' ? 'Uses your Claude subscription and shares its usage limits.' : 'Billed per use to your API account.'}{' '}
              Training data is {st.includeTraining ? 'shared' : 'not shared'}. Attached images are sent to this provider and kept with the conversation. <Link to="/settings" onClick={onClose}>Settings</Link>
              {turns.length > 0 && !pending && (
                <>
                  {' · '}
                  <button
                    className="link"
                    onClick={() => {
                      if (confirm('Clear the stored conversation? Proposals and their history are kept.')) void api('DELETE', '/api/assistant/history').then(() => qc.invalidateQueries({ queryKey: ['assistant'] }));
                    }}
                  >
                    Clear conversation
                  </button>
                </>
              )}
            </p>
          )}
        </>
      )}
    </aside>
  );
}

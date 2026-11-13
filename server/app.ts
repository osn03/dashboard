import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { z, ZodError } from 'zod';
import { DATE_RE, isValidDate } from '../shared/dates';
import {
  credentialsSchema,
  eventCreateSchema,
  eventPatchSchema,
  assistantChatSchema,
  assistantConfirmSchema,
  assistantSendSchema,
  googleCalendarsSchema,
  googleEventCreateSchema,
  googleEventPatchSchema,
  noteCreateSchema,
  projectCreateSchema,
  projectPatchSchema,
  scheduleTaskSchema,
  settingsSchema,
  subtaskCreateSchema,
  subtaskPatchSchema,
  taskCreateSchema,
  taskPatchSchema,
} from '../shared/types';
import * as auth from './auth';
import type { AssistantService } from './assistant';
import type { DB } from './db';
import type { GoogleService } from './google/service';
import type { IntervalsService } from './intervals';
import * as repo from './repo';
import { HttpError } from './repo';

const COOKIE = 'sid';

export interface AppOptions {
  db: DB;
  cookieSecure: boolean;
  google?: GoogleService;
  intervals?: IntervalsService;
  assistant?: AssistantService;
  /** Address the server listens on. The subscription assistant requires a loopback address. */
  bindHost?: string;
  /**
   * Told when a dashboard tab connects ('open'), when its connection ends ('lost'), and when a
   * tab says it is being closed ('closed'). Used to stop the server with the browser.
   */
  presence?: (event: 'open' | 'lost' | 'closed') => void;
  /** Sample data in a separate database; integrations make no network calls. */
  demo?: boolean;
}

export function createApp({ db, cookieSecure, google, intervals, assistant, presence, bindHost, demo = false }: AppOptions) {
  const app = new Hono();
  const loginLimiter = new auth.RateLimiter(8, 15 * 60_000);

  const body = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      throw new HttpError(400, 'Request body must be JSON');
    }
    return schema.parse(json);
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const where = first?.path.length ? `${first.path.join('.')}: ` : '';
      return c.json({ error: `Invalid input - ${where}${first?.message ?? 'validation failed'}`, issues: err.issues }, 400);
    }
    // Log the error type and message only; never request bodies or cookies.
    console.error(`[error] ${c.req.method} ${c.req.path}: ${err.name}: ${err.message}`);
    return c.json({ error: 'Something went wrong on the server. Your data was not changed.' }, 500);
  });

  // CSRF defence for cookie auth: state-changing requests must carry a custom
  // header (not settable cross-site without CORS) and a same-origin Origin if present.
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      if (c.req.header('x-requested-with') !== 'dashboard') throw new HttpError(403, 'Missing request header');
      const origin = c.req.header('origin');
      const host = c.req.header('x-forwarded-host') ?? c.req.header('host');
      if (origin && host && new URL(origin).host !== host) throw new HttpError(403, 'Cross-origin request refused');
    }
    c.header('Cache-Control', 'no-store');
    await next();
  });

  const startSession = (c: Context, userId: string) => {
    const s = auth.createSession(db, userId);
    setCookie(c, COOKIE, s.token, { httpOnly: true, sameSite: 'Lax', secure: cookieSecure, path: '/', maxAge: s.maxAge });
  };

  // ----- Auth (public) -----
  app.get('/api/auth/me', (c) => {
    const user = auth.sessionUser(db, getCookie(c, COOKIE));
    return c.json({ user: user ? { username: user.username } : null, needsSetup: !auth.hasUser(db), demo });
  });

  // Each open dashboard tab holds this stream open; it carries no data beyond a keep-alive.
  app.get('/api/auth/alive', (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      const leave = () => {
        if (open) presence?.('lost');
        open = false;
      };
      presence?.('open');
      stream.onAbort(leave);
      try {
        while (open) {
          await stream.writeSSE({ event: 'ping', data: '' });
          await stream.sleep(15_000);
        }
      } finally {
        leave();
      }
    }),
  );

  // Sent by a tab that is really being closed (or reloaded), as opposed to a connection that
  // merely dropped because the computer slept or the browser suspended the tab.
  app.post('/api/auth/bye', (c) => {
    presence?.('closed');
    return c.json({ ok: true });
  });

  app.post('/api/auth/setup', async (c) => {
    if (auth.hasUser(db)) throw new HttpError(409, 'An account already exists');
    const { username, password } = await body(c, credentialsSchema);
    startSession(c, auth.createUser(db, username, password));
    return c.json({ user: { username } });
  });

  app.post('/api/auth/login', async (c) => {
    const { username, password } = await body(
      c,
      z.object({ username: z.string().max(60), password: z.string().max(200) }).strict(),
    );
    if (!loginLimiter.allow(username.toLowerCase())) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    const userId = auth.checkLogin(db, username, password);
    if (!userId) throw new HttpError(401, 'Wrong username or password');
    loginLimiter.reset(username.toLowerCase());
    startSession(c, userId);
    return c.json({ user: { username } });
  });

  app.post('/api/auth/logout', (c) => {
    auth.destroySession(db, getCookie(c, COOKIE));
    deleteCookie(c, COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  // ----- Everything below requires a session -----
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/auth/')) return next();
    if (!auth.sessionUser(db, getCookie(c, COOKIE))) throw new HttpError(401, 'Not signed in');
    await next();
  });

  // Keep Google copies of time blocks in step after anything that can change a block or its task.
  app.use('/api/*', async (c, next) => {
    await next();
    const p = c.req.path;
    const touchesBlocks = p.startsWith('/api/tasks') || p.startsWith('/api/events') || p.startsWith('/api/assistant/actions');
    if (google && c.req.method !== 'GET' && touchesBlocks && c.res.ok) await google.mirrorSoon();
  });

  app.get('/api/settings', (c) => c.json(repo.getSettings(db)));
  app.put('/api/settings', async (c) => c.json(repo.saveSettings(db, await body(c, settingsSchema.strict()))));

  // ----- Projects -----
  app.get('/api/projects', (c) => c.json(repo.listProjects(db)));
  app.post('/api/projects', async (c) => c.json(repo.createProject(db, await body(c, projectCreateSchema)), 201));
  app.patch('/api/projects/:id', async (c) => c.json(repo.patchProject(db, c.req.param('id'), await body(c, projectPatchSchema))));
  app.delete('/api/projects/:id', (c) => {
    repo.deleteProject(db, c.req.param('id'));
    return c.json({ ok: true });
  });

  // ----- Tasks -----
  app.get('/api/tasks', (c) => c.json(repo.listTasks(db, c.req.query('done') === 'all' ? null : 60)));
  app.post('/api/tasks', async (c) => c.json(repo.createTask(db, await body(c, taskCreateSchema)), 201));
  app.get('/api/tasks/:id', (c) => c.json(repo.getTask(db, c.req.param('id'))));
  app.patch('/api/tasks/:id', async (c) => c.json(repo.patchTask(db, c.req.param('id'), await body(c, taskPatchSchema))));
  app.delete('/api/tasks/:id', (c) => {
    repo.deleteTask(db, c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/tasks/:id/complete', (c) => c.json(repo.finishTask(db, c.req.param('id'), 'done')));
  app.post('/api/tasks/:id/dismiss', (c) => c.json(repo.finishTask(db, c.req.param('id'), 'dismissed')));
  app.post('/api/tasks/:id/reopen', (c) => c.json(repo.reopenTask(db, c.req.param('id'))));
  app.get('/api/tasks/:id/history', (c) => c.json(repo.taskHistory(db, c.req.param('id'))));
  app.get('/api/tasks/:id/blocks', (c) => c.json(repo.listTaskBlocks(db, c.req.param('id'))));
  app.post('/api/tasks/:id/schedule', async (c) => {
    const { startAt, endAt } = await body(c, scheduleTaskSchema);
    return c.json(repo.scheduleTask(db, c.req.param('id'), startAt, endAt), 201);
  });
  app.post('/api/tasks/:id/subtasks', async (c) =>
    c.json(repo.addSubtask(db, c.req.param('id'), (await body(c, subtaskCreateSchema)).title), 201),
  );
  app.patch('/api/subtasks/:id', async (c) => c.json(repo.patchSubtask(db, c.req.param('id'), await body(c, subtaskPatchSchema))));
  app.delete('/api/subtasks/:id', (c) => c.json(repo.deleteSubtask(db, c.req.param('id'))));

  // ----- Reminders -----
  app.get('/api/reminders/due', (c) => c.json(repo.dueReminders(db)));
  app.post('/api/reminders/:taskId/ack', async (c) => {
    const { status } = await body(c, z.object({ status: z.enum(['delivered', 'failed']) }).strict());
    repo.ackReminder(db, c.req.param('taskId'), status);
    return c.json({ ok: true });
  });

  // ----- Events -----
  app.get('/api/events', (c) => {
    const from = c.req.query('from') ?? '';
    const to = c.req.query('to') ?? '';
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || !isValidDate(from) || !isValidDate(to) || to < from) {
      throw new HttpError(400, 'from and to must be dates (YYYY-MM-DD)');
    }
    return c.json([...repo.listEvents(db, from, to), ...(google?.listEvents(from, to) ?? []), ...(intervals?.listEvents(from, to) ?? [])]);
  });
  app.post('/api/events', async (c) => c.json(repo.createEvent(db, await body(c, eventCreateSchema)), 201));
  app.patch('/api/events/:id', async (c) => c.json(repo.patchEvent(db, c.req.param('id'), await body(c, eventPatchSchema))));
  app.delete('/api/events/:id', (c) => {
    repo.deleteEvent(db, c.req.param('id'));
    return c.json({ ok: true });
  });

  // ----- Google Calendar -----
  if (google) {
    const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;
    let lastReturnTo = '';
    app.get('/api/google/status', (c) => c.json(google.status()));
    app.post('/api/google/connect', async (c) => {
      const { returnTo } = await body(c, z.object({ returnTo: z.string().max(200) }).strict());
      // Only ever redirect back to this app: same origin as the API, or a local dev origin.
      lastReturnTo = returnTo === new URL(c.req.url).origin || LOCAL_ORIGIN.test(returnTo) ? returnTo : '';
      return c.json({ url: google.startConnect(lastReturnTo) });
    });
    app.get('/api/google/callback', async (c) => {
      const back = (origin: string, q: string) => c.redirect(`${origin}/settings?${q}`);
      if (c.req.query('error')) return back(lastReturnTo, 'google=denied');
      try {
        const origin = await google.finishConnect(c.req.query('code') ?? '', c.req.query('state') ?? '');
        return back(origin, 'google=connected');
      } catch (e) {
        const msg = e instanceof HttpError ? e.message : 'Google sign-in failed';
        return back(lastReturnTo, `google=error&message=${encodeURIComponent(msg)}`);
      }
    });
    app.post('/api/google/accounts/:id/disconnect', async (c) =>
      c.json({ ...(await google.disconnect(c.req.param('id'))), status: google.status() }),
    );
    app.put('/api/google/calendars', async (c) => {
      const { selected, defaultCalendarId, mirrorCalendarId, colors } = await body(c, googleCalendarsSchema);
      await google.setCalendars(selected, defaultCalendarId, mirrorCalendarId, colors);
      await google.syncAll().catch(() => undefined); // failures are reported in the status
      return c.json(google.status());
    });
    app.post('/api/google/events/:calendarId/:eventId/hide', (c) => {
      google.hide(c.req.param('calendarId'), c.req.param('eventId'));
      return c.json({ ok: true });
    });
    app.post('/api/google/unhide', async (c) => {
      const { calendarId, eventKey } = await body(c, z.object({ calendarId: z.string().max(300), eventKey: z.string().max(1100) }).strict());
      google.unhide(calendarId, eventKey);
      return c.json({ ok: true });
    });
    app.post('/api/google/sync', async (c) => {
      let error: string | null = null;
      await google.syncAll().catch((e) => {
        error = e instanceof HttpError ? e.message : 'Sync failed. Cached events are shown; see Settings for details.';
      });
      return c.json({ ok: !error, error, status: google.status() });
    });
    app.post('/api/google/events', async (c) => c.json(await google.createEvent(await body(c, googleEventCreateSchema)), 201));
    app.patch('/api/google/events/:calendarId/:eventId', async (c) =>
      c.json(await google.updateEvent(c.req.param('calendarId'), c.req.param('eventId'), await body(c, googleEventPatchSchema))),
    );
    app.delete('/api/google/events/:calendarId/:eventId', async (c) => {
      const scope = c.req.query('scope') === 'series' ? 'series' : 'occurrence';
      await google.deleteEvent(c.req.param('calendarId'), c.req.param('eventId'), scope, c.req.query('etag') || null);
      return c.json({ ok: true });
    });
  }

  // ----- Training (Intervals.icu, read-only) -----
  if (intervals) {
    app.get('/api/training/summary', (c) => {
      const weekOf = c.req.query('weekOf');
      if (weekOf && !isValidDate(weekOf)) throw new HttpError(400, 'weekOf must be a date (YYYY-MM-DD)');
      return c.json(intervals.summary(weekOf));
    });
    app.post('/api/training/sync', async (c) => {
      let error: string | null = null;
      await intervals.sync().catch((e) => {
        error = e instanceof HttpError ? e.message : 'Import failed.';
      });
      return c.json({ ok: !error, error, status: intervals.status() });
    });
  }

  // ----- Assistant -----
  if (assistant) {
    // The subscription assistant is personal and local: it only answers requests made on this
    // computer. A request that arrives through a proxy or tunnel (or to a non-loopback
    // address) is refused, whoever is signed in.
    const isLocal = (c: Context) => {
      const proxied = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'via', 'cf-connecting-ip', 'cf-ray', 'cdn-loop'].some((h) => c.req.header(h));
      const host = (c.req.header('host') ?? new URL(c.req.url).host).replace(/:\d+$/, '').toLowerCase();
      return !proxied && ['127.0.0.1', 'localhost', '[::1]'].includes(host) && (bindHost === undefined || ['127.0.0.1', 'localhost', '::1'].includes(bindHost));
    };
    const REMOTE = 'The Claude Code assistant uses your personal Claude subscription and only works when the dashboard is opened on this computer (http://127.0.0.1). It is switched off for remote or tunnelled access.';
    const guard = (c: Context) => {
      if (repo.getSettings(db).aiProvider === 'claude_code' && !isLocal(c)) throw new HttpError(403, REMOTE);
    };

    app.get('/api/assistant/status', async (c) => {
      const st = await assistant.status(c.req.query('fresh') === '1');
      const remoteBlocked = st.provider === 'claude_code' && !isLocal(c);
      // Remote viewers learn nothing about the local Claude Code installation.
      return c.json(remoteBlocked ? { ...st, state: 'not_configured', message: REMOTE, claudeCode: null, remoteBlocked } : st);
    });
    app.get('/api/assistant/history', (c) => c.json(assistant.history()));
    app.get('/api/assistant/images/:id', (c) => {
      const im = assistant.image(c.req.param('id'));
      return c.body(new Uint8Array(im.data), 200, { 'content-type': im.mediaType, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' });
    });
    app.delete('/api/assistant/history', (c) => {
      assistant.clearHistory();
      return c.json({ ok: true });
    });

    // One turn, streamed as server-sent events: delta (text), tool, done, error.
    // Closing the connection (the Stop button) cancels the run and stops Claude Code.
    app.post('/api/assistant/send', async (c) => {
      guard(c);
      if (Number(c.req.header('content-length') ?? 0) > 32 * 1024 * 1024) throw new HttpError(400, 'The message is too large.');
      const { text, images } = await body(c, assistantSendSchema);
      return streamSSE(c, async (stream) => {
        const abort = new AbortController();
        stream.onAbort(() => abort.abort());
        const emit = (event: string, data: unknown) => stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => undefined);
        try {
          const r = await assistant.send(text, {
            signal: abort.signal,
            onText: (delta) => void emit('delta', { text: delta }),
            onTool: (name, ok) => void emit('tool', { name, ok }),
            onNotice: (text) => void emit('notice', { text }),
          }, images);
          await emit('done', r);
        } catch (e) {
          await emit('error', { message: e instanceof HttpError ? e.message : 'The assistant could not answer. Nothing was changed.', status: e instanceof HttpError ? e.status : 500 });
        }
      });
    });
    // Non-streaming variant for the API-billed providers.
    app.post('/api/assistant/chat', async (c) => {
      guard(c);
      return c.json(await assistant.chat((await body(c, assistantChatSchema)).messages));
    });
    app.get('/api/assistant/actions', (c) => c.json(assistant.listActions()));
    app.post('/api/assistant/actions/:id/confirm', async (c) => {
      const { digest } = await body(c, assistantConfirmSchema);
      return c.json(await assistant.confirm(c.req.param('id'), digest));
    });
    app.post('/api/assistant/actions/:id/reject', (c) => c.json(assistant.reject(c.req.param('id'))));
    app.post('/api/assistant/actions/:id/undo', async (c) => c.json(await assistant.undo(c.req.param('id'))));
  }

  // ----- Notes -----
  app.get('/api/notes', (c) => c.json(repo.listNotes(db)));
  app.post('/api/notes', async (c) => c.json(repo.createNote(db, await body(c, noteCreateSchema)), 201));
  app.delete('/api/notes/:id', (c) => {
    repo.deleteNote(db, c.req.param('id'));
    return c.json({ ok: true });
  });

  // ----- Export -----
  app.get('/api/export', (c) => {
    c.header('Content-Disposition', `attachment; filename="dashboard-export-${new Date().toISOString().slice(0, 10)}.json"`);
    return c.json(repo.exportAll(db));
  });

  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  return app;
}

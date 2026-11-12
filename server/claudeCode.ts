// Assistant provider: the user's own, locally installed Claude Code, signed in with their
// Claude subscription through Anthropic's official sign-in (`claude auth login`).
//
// What this module does and does not do:
//  - It runs the unmodified Claude Code executable through the official Claude Agent SDK.
//  - It never reads, copies, stores or forwards sign-in tokens. It only asks the CLI
//    whether it is signed in (`claude auth status`), which prints no credentials.
//  - It never passes an Anthropic API key to Claude Code: the child process gets a small
//    allow-listed environment, and a run is aborted if Claude Code reports that it would
//    authenticate with anything other than the subscription sign-in.
//  - Claude Code's own tools (shell, files, web, subagents, ...) are switched off. Only the
//    dashboard tools registered here exist, and every run is checked for that before the
//    first model request.
//  - Processes are started with an executable path and an argument array (never through a
//    shell). The user's message travels on stdin.
import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeCodeStatus } from '../shared/types';

export const MCP_SERVER = 'dashboard';
export const toolId = (name: string) => `mcp__${MCP_SERVER}__${name}`;

/** Model choices offered in Settings. Aliases are resolved by Claude Code itself. */
export const CLAUDE_CODE_MODELS = [
  { id: 'sonnet', label: 'Sonnet (recommended)', note: 'Included in subscription plans. Good default for planning.', extraUsage: false },
  { id: 'haiku', label: 'Haiku (fastest, lightest on limits)', note: 'Included in subscription plans.', extraUsage: false },
  { id: 'opus', label: 'Opus (most capable included model)', note: 'Included, but uses your plan limits considerably faster.', extraUsage: false },
  { id: 'fable', label: 'Fable (may need usage credits)', note: 'Depending on your plan, Fable is billed to usage credits instead of the plan’s included limits.', extraUsage: true },
] as const;
export const DEFAULT_CLAUDE_CODE_MODEL = 'sonnet';

/** Only these variables reach Claude Code. No API keys, no dashboard secrets. */
const ENV_ALLOW = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'SystemDrive', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'TEMP', 'TMP', 'TMPDIR', 'USERNAME', 'USER', 'USERDOMAIN',
  'LANG', 'LC_ALL', 'TZ', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE',
  'CLAUDE_CONFIG_DIR', // where the user's own Claude Code sign-in lives, if they moved it
];
/** Settings that would send Claude Code to API billing or another provider instead of the subscription. */
const BILLING_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

export function childEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOW) if (source[k] !== undefined) out[k] = source[k]!;
  return out;
}

/** Names (never values) of settings in the dashboard's environment that are deliberately withheld from Claude Code. */
export function withheldBillingSettings(source: NodeJS.ProcessEnv = process.env): string[] {
  return BILLING_ENV.filter((k) => !!source[k]);
}

/**
 * Finds the installed Claude Code executable. No shell is involved: PATH is scanned here.
 * A path with spaces is fine because it is always passed as one argument.
 */
export function findClaudeCode(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = isFile): { path: string | null; problem: string | null } {
  const explicit = env.CLAUDE_CODE_PATH?.trim();
  if (explicit) {
    if (!isAbsolute(explicit) || !exists(explicit)) return { path: null, problem: 'CLAUDE_CODE_PATH in .env does not point to an existing file. Use the full path to claude.exe.' };
    if (process.platform === 'win32' && extname(explicit).toLowerCase() !== '.exe') return { path: null, problem: 'CLAUDE_CODE_PATH must point to claude.exe (not a .cmd or .ps1 launcher).' };
    return { path: explicit, problem: null };
  }
  const win = process.platform === 'win32';
  const names = win ? ['claude.exe'] : ['claude'];
  const home = env.USERPROFILE ?? env.HOME ?? '';
  const dirs = [
    ...(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean),
    ...(home ? [join(home, '.local', 'bin'), join(home, '.claude', 'local')] : []),
  ];
  for (const dir of dirs) for (const n of names) if (exists(join(dir, n))) return { path: join(dir, n), problem: null };
  if (win && dirs.some((d) => exists(join(d, 'claude.cmd')))) {
    return { path: null, problem: 'Only an npm launcher (claude.cmd) was found. Install the native Claude Code for Windows, or set CLAUDE_CODE_PATH to a claude.exe.' };
  }
  return { path: null, problem: null };
}
function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

export type Exec = (file: string, args: string[], opts: { env: Record<string, string>; timeoutMs: number }) => Promise<{ code: number | null; stdout: string; stderr: string; notFound?: boolean }>;

/** Runs a program with an argument array. Never a shell; windowsHide keeps it invisible. */
export const execDirect: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    nodeExecFile(file, args, { env: opts.env, timeout: opts.timeoutMs, windowsHide: true, shell: false, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
      resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), notFound: e?.code === 'ENOENT' });
    });
  });

/**
 * Connection status from the CLI's own commands. `claude auth status` reports whether it is
 * signed in and how; it does not print tokens, and nothing else is read.
 */
export async function claudeCodeStatus(exec: Exec = execDirect, env: NodeJS.ProcessEnv = process.env, exists?: (p: string) => boolean): Promise<ClaudeCodeStatus> {
  const withheld = withheldBillingSettings(env);
  const base: ClaudeCodeStatus = {
    state: 'not_installed', path: null, version: null, authMethod: null, plan: null, loginExpiresAt: null, message: '', withheld, checkedAt: new Date().toISOString(),
  };
  const found = findClaudeCode(env, exists);
  if (!found.path) {
    return { ...base, message: found.problem ?? 'Claude Code was not found on this computer. Install it from https://claude.com/claude-code, then run "claude auth login" in a terminal.' };
  }
  const e = childEnv(env);
  const v = await exec(found.path, ['--version'], { env: e, timeoutMs: 15_000 });
  if (v.notFound || v.code !== 0) {
    return { ...base, path: found.path, state: v.notFound ? 'not_installed' : 'error', message: 'Claude Code was found but did not start. Try running "claude --version" in a terminal.' };
  }
  const version = v.stdout.trim().split(/\s+/)[0] || null;
  const a = await exec(found.path, ['auth', 'status'], { env: e, timeoutMs: 20_000 });
  let info: any = null;
  try {
    info = JSON.parse(a.stdout);
  } catch {
    /* older versions or unexpected output */
  }
  const s: ClaudeCodeStatus = { ...base, path: found.path, version };
  if (!info || typeof info.loggedIn !== 'boolean') {
    return { ...s, state: 'error', message: 'Could not read the sign-in status from Claude Code. Update Claude Code ("claude update"), then check again.' };
  }
  s.authMethod = typeof info.authMethod === 'string' ? info.authMethod : null;
  s.plan = typeof info.subscriptionType === 'string' ? info.subscriptionType : null;
  s.loginExpiresAt = typeof info.loginExpiresAt === 'string' ? info.loginExpiresAt : null;
  if (!info.loggedIn) {
    return { ...s, state: 'signed_out', message: 'Claude Code is not signed in. Open a terminal, run "claude auth login", and sign in with your Claude account in the browser.' };
  }
  if (s.loginExpiresAt && Date.parse(s.loginExpiresAt) < Date.now()) {
    return { ...s, state: 'signed_out', message: 'Your Claude Code sign-in has expired. Open a terminal and run "claude auth login" to sign in again.' };
  }
  if (s.authMethod !== 'claude.ai' || (info.apiProvider && info.apiProvider !== 'firstParty')) {
    return {
      ...s, state: 'conflict',
      message: `Claude Code is signed in with "${s.authMethod ?? 'an unknown method'}", not a Claude subscription. Using it would be billed as API usage, so the assistant will not run. Run "claude auth logout", then "claude auth login" and choose your Claude subscription account.`,
    };
  }
  return { ...s, state: 'ready', message: 'Signed in with your Claude subscription.' };
}

// ---------------------------------------------------------------- running a turn

export interface DashboardTool {
  name: string;
  description: string;
  /** zod raw shape */
  shape: Record<string, unknown>;
  /** Validates and runs. Throws with a user-safe message on bad input. */
  run: (input: unknown) => unknown;
}

/** The parts of the Agent SDK this module uses (replaceable in tests). */
export interface AgentSdk {
  query: (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => Query | AsyncIterable<SDKMessage>;
  tool: (name: string, description: string, shape: any, handler: (args: any) => Promise<any>) => any;
  createSdkMcpServer: (o: { name: string; version?: string; tools: any[] }) => any;
}

export type ClaudeCodeErrorCode =
  | 'not_installed' | 'signed_out' | 'conflict' | 'rate_limit' | 'credits_required' | 'extra_usage' | 'cancelled' | 'timeout' | 'unsafe_tools' | 'model' | 'overloaded' | 'failed';

export class ClaudeCodeError extends Error {
  constructor(public code: ClaudeCodeErrorCode, message: string, /** epoch seconds when the plan limit resets, if known */ public resetsAt?: number) {
    super(message);
  }
}

export interface RunParams {
  executable: string;
  model: string;
  system: string;
  /** The whole prompt. Sent to the process on stdin, never on the command line. */
  prompt: string;
  /** Images the user attached (base64). Sent on stdin with the prompt; no file is written. */
  images?: { label: string; mediaType: string; data: string }[];
  tools: DashboardTool[];
  signal: AbortSignal;
  timeoutMs: number;
  /** Empty working directory for the process. */
  cwd: string;
  /**
   * false (default): stop as soon as Claude reports that the plan's included limit is used up
   * and paid extra usage ("usage credits") is being drawn on.
   */
  allowExtraUsage: boolean;
  onText?: (delta: string) => void;
  onTool?: (name: string, ok: boolean) => void;
  /** Called once when a run is being paid from extra usage credits (only possible when allowed). */
  onExtraUsage?: (resetsAt?: number) => void;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  text: string;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

const fmtReset = (epochSeconds?: number) => (epochSeconds ? ` Limits reset around ${new Date(epochSeconds * 1000).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}.` : '');

export async function runClaudeCode(sdk: AgentSdk, p: RunParams): Promise<RunResult> {
  mkdirSync(p.cwd, { recursive: true });
  const allowed = p.tools.map((t) => toolId(t.name));
  const allowedSet = new Set(allowed);

  const server = sdk.createSdkMcpServer({
    name: MCP_SERVER,
    version: '1.0.0',
    tools: p.tools.map((t) =>
      sdk.tool(t.name, t.description, t.shape, async (args: unknown) => {
        try {
          const out = t.run(args);
          p.onTool?.(t.name, true);
          return { content: [{ type: 'text', text: JSON.stringify(out) }] };
        } catch (e) {
          p.onTool?.(t.name, false);
          return { content: [{ type: 'text', text: e instanceof Error ? e.message : 'Tool failed.' }], isError: true };
        }
      }),
    ),
  });

  const abort = new AbortController();
  let timedOut = false;
  const onAbort = () => abort.abort();
  p.signal.addEventListener('abort', onAbort);
  if (p.signal.aborted) abort.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, p.timeoutMs);

  // One user turn, delivered over stdin. The generator stays open until the run ends so the
  // SDK can keep serving the in-process tools.
  let finish: () => void = () => {};
  const done = new Promise<void>((r) => (finish = r));
  async function* input(): AsyncGenerator<SDKUserMessage> {
    const content = p.images?.length
      ? [
          ...p.images.flatMap((im) => [
            { type: 'text' as const, text: im.label },
            { type: 'image' as const, source: { type: 'base64' as const, media_type: im.mediaType, data: im.data } },
          ]),
          { type: 'text' as const, text: p.prompt },
        ]
      : p.prompt;
    yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } as SDKUserMessage;
    await done;
  }

  const options: Options = {
    pathToClaudeCodeExecutable: p.executable,
    model: p.model,
    systemPrompt: p.system, // replaces Claude Code's coding prompt entirely
    tools: [], // no built-in tools: no shell, files, web, subagents
    mcpServers: { [MCP_SERVER]: server },
    strictMcpConfig: true, // ignore every other MCP server configured on this machine
    allowedTools: allowed,
    permissionMode: 'dontAsk', // anything not explicitly allowed is denied without asking
    // Second gate, checked before every tool call regardless of permission rules.
    hooks: {
      PreToolUse: [{
        hooks: [async (input) => {
          const i = input as { tool_name?: string; mcp_server?: { source?: string } };
          const ok = !!i.tool_name && allowedSet.has(i.tool_name) && (!i.mcp_server || i.mcp_server.source === 'sdk');
          return ok ? {} : { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: 'This tool is not available in the dashboard assistant.' } };
        }],
      }],
    },
    settingSources: [], // no user/project settings, CLAUDE.md, hooks or plugins
    plugins: [],
    skills: [],
    persistSession: false, // the dashboard keeps its own history; nothing is written to Claude Code's
    cwd: p.cwd,
    env: childEnv(p.env),
    abortController: abort,
    includePartialMessages: true,
    maxTurns: 14,
  };

  let text = '';
  let streamed = '';
  let model: string | null = null;
  let failure: ClaudeCodeError | null = null;
  const usage = { inputTokens: 0, outputTokens: 0 };
  let limit: { resetsAt?: number; credits?: boolean } = {};
  let notifiedExtra = false;

  try {
    for await (const m of sdk.query({ prompt: input(), options }) as AsyncIterable<SDKMessage>) {
      if (m.type === 'system' && m.subtype === 'init') {
        model = m.model;
        // Refuse API billing: the only acceptable credential is the subscription sign-in.
        if (m.apiKeySource !== 'none' && m.apiKeySource !== 'oauth') {
          failure = new ClaudeCodeError('conflict', `Claude Code was about to authenticate with an API key (${m.apiKeySource}) instead of your subscription sign-in, so the request was stopped before anything was sent. Remove that key from Claude Code's settings or environment, or run "claude auth login".`);
          break;
        }
        // Refuse to run if anything other than the dashboard tools is exposed to the model.
        const extra = m.tools.filter((t) => !allowedSet.has(t));
        const foreign = (m.mcp_servers ?? []).filter((x) => x.name !== MCP_SERVER || (x.source !== undefined && x.source !== 'sdk'));
        if (extra.length || foreign.length) {
          const what = [...extra, ...foreign.map((x) => `MCP server ${x.name}`)].slice(0, 5).join(', ');
          failure = new ClaudeCodeError('unsafe_tools', `Claude Code offered tools outside the dashboard set (${what}), so the request was stopped before anything was sent.`);
          break;
        }
      } else if (m.type === 'stream_event' && m.parent_tool_use_id === null) {
        const ev = m.event;
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          streamed += ev.delta.text;
          p.onText?.(ev.delta.text);
        }
      } else if (m.type === 'rate_limit_event') {
        const r = m.rate_limit_info;
        if (r.status === 'rejected') limit = { resetsAt: r.resetsAt, credits: r.errorCode === 'credits_required' || r.rateLimitType === 'overage' };
        if (r.isUsingOverage || r.overageInUse) {
          if (!p.allowExtraUsage) {
            failure = new ClaudeCodeError(
              'extra_usage',
              `Your Claude plan’s included usage is used up, and Claude is now charging requests to paid extra usage (usage credits). The assistant stopped so that no further requests are charged.${fmtReset(r.resetsAt)} To continue anyway, switch on “Allow paid extra usage” in Settings → Assistant.`,
              r.resetsAt,
            );
            break;
          }
          if (!notifiedExtra) p.onExtraUsage?.(r.resetsAt);
          notifiedExtra = true;
        }
      } else if (m.type === 'assistant' && m.error) {
        failure = mapError(m.error, limit);
      } else if (m.type === 'result') {
        usage.inputTokens = m.usage?.input_tokens ?? 0;
        usage.outputTokens = m.usage?.output_tokens ?? 0;
        if (m.subtype === 'success' && !m.is_error) text = m.result ?? '';
        else if (!failure) {
          const detail = m.subtype === 'success' ? String(m.result ?? '') : (m.errors ?? []).join(' ');
          failure = m.subtype === 'error_max_turns'
            ? new ClaudeCodeError('failed', 'The assistant stopped after too many steps. Try a narrower question.')
            : classifyText(detail, limit);
        }
        break;
      }
    }
  } catch (e) {
    if (!failure) {
      if (timedOut) failure = new ClaudeCodeError('timeout', `Claude Code did not finish within ${Math.round(p.timeoutMs / 1000)} seconds and was stopped.`);
      else if (abort.signal.aborted) failure = new ClaudeCodeError('cancelled', 'Stopped.');
      else if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') failure = new ClaudeCodeError('not_installed', 'Claude Code could not be started. Check that it is still installed.');
      else failure = classifyText(e instanceof Error ? e.message : '', limit);
    }
  } finally {
    clearTimeout(timer);
    p.signal.removeEventListener('abort', onAbort);
    finish();
    if (!abort.signal.aborted) abort.abort(); // make sure the child process is gone
  }
  if (!failure && timedOut) failure = new ClaudeCodeError('timeout', `Claude Code did not finish within ${Math.round(p.timeoutMs / 1000)} seconds and was stopped.`);
  if (!failure && p.signal.aborted) failure = new ClaudeCodeError('cancelled', 'Stopped.');
  if (failure) throw failure;
  return { text: text || streamed, model, usage };
}

function mapError(error: string, limit: { resetsAt?: number; credits?: boolean }): ClaudeCodeError {
  switch (error) {
    case 'authentication_failed':
    case 'verification_required':
      return new ClaudeCodeError('signed_out', 'Claude Code’s sign-in has expired or is no longer valid. Open a terminal, run "claude auth login", then try again.');
    case 'oauth_org_not_allowed':
    case 'account_on_hold':
      return new ClaudeCodeError('signed_out', 'Your Claude account cannot be used by Claude Code right now. Run "claude" in a terminal to see the details.');
    case 'billing_error':
      return new ClaudeCodeError('credits_required', 'This request needs usage credits that are not available on your account (for example a model outside your plan’s included limits). Choose another model in Settings → Assistant. Nothing was charged to an API key.');
    case 'rate_limit':
      return limit.credits
        ? new ClaudeCodeError('credits_required', 'The selected model needs usage credits on your plan, and none are available. Choose Sonnet or Haiku in Settings → Assistant.')
        : new ClaudeCodeError('rate_limit', `You have reached your Claude subscription’s usage limit. The assistant shares that limit with Claude Code and the Claude apps.${fmtReset(limit.resetsAt)} Nothing was sent to API billing.`, limit.resetsAt);
    case 'model_not_found':
      return new ClaudeCodeError('model', 'The selected model is not available for your account. Choose another model in Settings → Assistant.');
    case 'overloaded':
    case 'server_error':
      return new ClaudeCodeError('overloaded', 'Claude is temporarily overloaded or unavailable. Nothing was changed; try again in a moment.');
    default:
      return new ClaudeCodeError('failed', 'Claude Code could not complete the request. Nothing was changed.');
  }
}

/** Best-effort classification of an error text from the CLI (wording can change between versions). */
function classifyText(detail: string, limit: { resetsAt?: number; credits?: boolean }): ClaudeCodeError {
  const d = detail.toLowerCase();
  if (/login expired|not logged in|\/login|authenticat|oauth|401/.test(d)) return mapError('authentication_failed', limit);
  if (/usage limit|rate limit|limit reached|429/.test(d) || limit.resetsAt) return mapError('rate_limit', limit);
  if (/credit|billing/.test(d)) return mapError('billing_error', limit);
  return new ClaudeCodeError('failed', 'Claude Code could not complete the request. Nothing was changed.');
}

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { todayIn } from '../../shared/dates';
import type { Project, Settings } from '../../shared/types';
import { useNow } from './ui';

interface Env {
  settings: Settings;
  tz: string;
  now: Date;
  today: string;
  projects: Project[];
}

const Ctx = createContext<Env | null>(null);

export function EnvProvider({ settings, projects, children }: { settings: Settings; projects: Project[]; children: ReactNode }) {
  const now = useNow(30_000);
  const today = todayIn(settings.timezone, now);
  const value = useMemo(() => ({ settings, tz: settings.timezone, now, today, projects }), [settings, now, today, projects]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEnv(): Env {
  const v = useContext(Ctx);
  if (!v) throw new Error('EnvProvider missing');
  return v;
}

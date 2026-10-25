import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { User } from '@rih/shared';
import { ApiError, api, getToken, setToken } from './api';

/**
 * App-level providers: session, theme, and toasts.
 *
 * Kept in one file because they are small and always used together — a page
 * needs all three, and three separate context files would be more ceremony than
 * value at this size.
 */

/* --------------------------------------------------------------- session -- */

interface AuthState {
  user: User | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('loading');

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null);
      setStatus('anonymous');
      return;
    }
    try {
      const { data } = await api.auth.session();
      setUser(data.user);
      setStatus('authenticated');
    } catch {
      setToken(null);
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const { data } = await api.auth.login({ email, password });
    setToken(data.token);
    setUser(data.user);
    setStatus('authenticated');
  }, []);

  const register = useCallback(async (email: string, password: string, displayName: string) => {
    const { data } = await api.auth.register({ email, password, displayName });
    setToken(data.token);
    setUser(data.user);
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* the local session is cleared regardless */
    }
    setToken(null);
    setUser(null);
    setStatus('anonymous');
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, status, login, register, logout, refresh }),
    [user, status, login, register, logout, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}

/* ----------------------------------------------------------------- theme -- */

type Theme = 'dark' | 'light' | 'system';

interface ThemeState {
  theme: Theme;
  resolved: 'dark' | 'light';
  setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeState | null>(null);
const THEME_KEY = 'rih.theme';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      return (window.localStorage.getItem(THEME_KEY) as Theme | null) ?? 'dark';
    } catch {
      return 'dark';
    }
  });

  const resolved: 'dark' | 'light' = useMemo(() => {
    if (theme !== 'system') return theme;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [resolved]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside <ThemeProvider>');
  return context;
}

/* ---------------------------------------------------------------- toasts -- */

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastState | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, number>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((current) => [...current.slice(-3), { ...toast, id }]);
      const timer = window.setTimeout(() => dismiss(id), toast.tone === 'error' ? 9000 : 5000);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast(): ToastState {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>');
  return context;
}

/** Turn any thrown value into a toast, preferring the API's own message. */
export function useErrorToast(): (error: unknown) => void {
  const { push } = useToast();
  return useCallback(
    (error: unknown) => {
      if (error instanceof ApiError) {
        push({
          tone: error.retryable ? 'warning' : 'error',
          title: error.message,
          description: `${error.code}${error.requestId !== 'n/a' ? ` · request ${error.requestId}` : ''}`,
        });
        return;
      }
      push({
        tone: 'error',
        title: 'Something went wrong',
        description: error instanceof Error ? error.message : String(error),
      });
    },
    [push],
  );
}

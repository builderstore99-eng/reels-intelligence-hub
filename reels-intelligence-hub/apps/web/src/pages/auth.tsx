import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, KeyRound, Sparkles } from 'lucide-react';
import { loginSchema, passwordSchema, registerSchema } from '@rih/shared';
import { api, ApiError } from '../lib/api';
import { useAuth, useToast } from '../lib/app-context';
import { Button, FieldError, FieldHelp, Input, Label } from '../components/ui';

/**
 * Authentication screen.
 *
 * One component, three modes. The forms validate with the *same* Zod schemas the
 * Worker uses, so the browser and the server cannot disagree about what a valid
 * password is.
 */

type Mode = 'login' | 'register' | 'reset';

export default function AuthPage({ mode }: { mode: Mode }) {
  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside className="relative hidden flex-1 flex-col justify-between overflow-hidden border-r border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-10 lg:flex">
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-[var(--radius-xs)] bg-[var(--color-accent-500)] text-sm font-bold text-white">
            R
          </span>
          <span className="text-[13px] font-semibold tracking-tight text-[var(--color-ink-100)]">
            Reels Intelligence Hub
          </span>
        </div>

        <div className="max-w-md">
          <h1 className="text-[30px] font-semibold leading-tight tracking-tight text-[var(--color-ink-100)]">
            Discover content. Extract knowledge. Build your own AI research library.
          </h1>
          <p className="mt-4 text-[14px] leading-relaxed text-[var(--color-ink-400)]">
            Collect reels, design references and documents into searchable collections, then ask
            questions across everything you have saved. Answers cite the items they came from — or
            say plainly that the evidence is not there.
          </p>

          <ul className="mt-8 space-y-3">
            {[
              'Profile, design and topic research with a real processing pipeline',
              'Hybrid search: keyword and semantic, fused and ranked',
              'Retrieval-augmented chat with source citations on every claim',
              'Bring your own provider keys — encrypted at rest, never exposed',
            ].map((line) => (
              <li
                key={line}
                className="flex items-start gap-2.5 text-[13px] text-[var(--color-ink-300)]"
              >
                <Sparkles className="mt-0.5 size-3.5 shrink-0 text-[var(--color-accent-400)]" />
                {line}
              </li>
            ))}
          </ul>
        </div>

        <p className="text-[11px] leading-relaxed text-[var(--color-ink-500)]">
          Only content this app is authorised to access is collected. No account rotation, no
          evasion of platform limits, no invented results.
        </p>
      </aside>

      <main className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 lg:hidden">
            <span className="grid size-8 place-items-center rounded-[var(--radius-xs)] bg-[var(--color-accent-500)] text-sm font-bold text-white">
              R
            </span>
          </div>
          {mode === 'login' ? (
            <LoginForm />
          ) : mode === 'register' ? (
            <RegisterForm />
          ) : (
            <ResetForm />
          )}
        </div>
      </main>
    </div>
  );
}

function LoginForm() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: z.infer<typeof loginSchema>) {
    setServerError(null);
    try {
      await login(values.email, values.password);
      navigate('/', { replace: true });
    } catch (error) {
      setServerError(error instanceof ApiError ? error.message : 'Could not sign in.');
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <div>
        <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-ink-100)]">
          Sign in
        </h2>
        <p className="mt-1 text-[13px] text-[var(--color-ink-400)]">
          Welcome back to your research workspace.
        </p>
      </div>

      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          invalid={Boolean(form.formState.errors.email)}
          {...form.register('email')}
        />
        <FieldError>{form.formState.errors.email?.message}</FieldError>
      </div>

      <div>
        <Label
          htmlFor="password"
          hint={
            <Link to="/reset" className="hover:text-[var(--color-accent-400)]">
              Forgot password?
            </Link>
          }
        >
          Password
        </Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••••"
          invalid={Boolean(form.formState.errors.password)}
          {...form.register('password')}
        />
        <FieldError>{form.formState.errors.password?.message}</FieldError>
      </div>

      {serverError ? (
        <p className="rounded-[var(--radius-sm)] border border-[var(--color-danger-500)]/30 bg-[var(--color-danger-500)]/8 px-3 py-2 text-[12px] text-[var(--color-ink-100)]">
          {serverError}
        </p>
      ) : null}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        loading={form.formState.isSubmitting}
      >
        Sign in <ArrowRight className="size-4" />
      </Button>

      <p className="text-center text-[12px] text-[var(--color-ink-400)]">
        No account yet?{' '}
        <Link to="/register" className="font-medium text-[var(--color-accent-400)] hover:underline">
          Create one
        </Link>
      </p>
    </form>
  );
}

function RegisterForm() {
  const { register: registerUser } = useAuth();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm<z.infer<typeof registerSchema>>({
    resolver: zodResolver(registerSchema),
    defaultValues: { email: '', password: '', displayName: '' },
  });

  async function onSubmit(values: z.infer<typeof registerSchema>) {
    setServerError(null);
    try {
      await registerUser(values.email, values.password, values.displayName);
      navigate('/', { replace: true });
    } catch (error) {
      setServerError(error instanceof ApiError ? error.message : 'Could not create the account.');
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <div>
        <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-ink-100)]">
          Create your account
        </h2>
        <p className="mt-1 text-[13px] text-[var(--color-ink-400)]">
          Your research is private to this account.
        </p>
      </div>

      <div>
        <Label htmlFor="displayName">Display name</Label>
        <Input
          id="displayName"
          placeholder="Ada Lovelace"
          invalid={Boolean(form.formState.errors.displayName)}
          {...form.register('displayName')}
        />
        <FieldError>{form.formState.errors.displayName?.message}</FieldError>
      </div>

      <div>
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          placeholder="you@example.com"
          invalid={Boolean(form.formState.errors.email)}
          {...form.register('email')}
        />
        <FieldError>{form.formState.errors.email?.message}</FieldError>
      </div>

      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          placeholder="At least 10 characters"
          invalid={Boolean(form.formState.errors.password)}
          {...form.register('password')}
        />
        <FieldError>{form.formState.errors.password?.message}</FieldError>
        <FieldHelp>Length matters more than symbols. Ten characters or more.</FieldHelp>
      </div>

      {serverError ? (
        <p className="rounded-[var(--radius-sm)] border border-[var(--color-danger-500)]/30 bg-[var(--color-danger-500)]/8 px-3 py-2 text-[12px] text-[var(--color-ink-100)]">
          {serverError}
        </p>
      ) : null}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        className="w-full"
        loading={form.formState.isSubmitting}
      >
        Create account <ArrowRight className="size-4" />
      </Button>

      <p className="text-center text-[12px] text-[var(--color-ink-400)]">
        Already have an account?{' '}
        <Link to="/login" className="font-medium text-[var(--color-accent-400)] hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}

function ResetForm() {
  const { push } = useToast();
  const [stage, setStage] = useState<'request' | 'confirm'>('request');
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function requestReset() {
    setBusy(true);
    setNote(null);
    try {
      const { data } = await api.auth.requestReset(email);
      setNote(data.note ?? null);
      if (data.devToken) {
        setToken(data.devToken);
        setStage('confirm');
        push({
          tone: 'info',
          title: 'Development mode',
          description: 'No email provider is configured, so the reset token was returned directly.',
        });
      } else {
        setStage('confirm');
      }
    } catch (error) {
      push({ tone: 'error', title: error instanceof ApiError ? error.message : 'Request failed' });
    } finally {
      setBusy(false);
    }
  }

  async function confirmReset() {
    setBusy(true);
    try {
      const parsed = passwordSchema.safeParse(password);
      if (!parsed.success) {
        push({ tone: 'error', title: parsed.error.issues[0]?.message ?? 'Password too weak' });
        return;
      }
      await api.auth.confirmReset({ token, password });
      push({ tone: 'success', title: 'Password updated', description: 'You can sign in now.' });
      window.location.href = '/login';
    } catch (error) {
      push({ tone: 'error', title: error instanceof ApiError ? error.message : 'Reset failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[20px] font-semibold tracking-tight text-[var(--color-ink-100)]">
          Reset your password
        </h2>
        <p className="mt-1 text-[13px] text-[var(--color-ink-400)]">
          {stage === 'request'
            ? 'Enter your email and we will start a reset.'
            : 'Paste the reset token you received and choose a new password.'}
        </p>
      </div>

      {stage === 'request' ? (
        <>
          <div>
            <Label htmlFor="reset-email">Email</Label>
            <Input
              id="reset-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            loading={busy}
            onClick={() => void requestReset()}
            icon={<KeyRound className="size-4" />}
          >
            Send reset token
          </Button>
        </>
      ) : (
        <>
          <div>
            <Label htmlFor="reset-token">Reset token</Label>
            <Input
              id="reset-token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste your token"
            />
          </div>
          <div>
            <Label htmlFor="reset-password">New password</Label>
            <Input
              id="reset-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="At least 10 characters"
            />
          </div>
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            loading={busy}
            onClick={() => void confirmReset()}
          >
            Set new password
          </Button>
        </>
      )}

      {note ? (
        <p className="text-[12px] leading-relaxed text-[var(--color-ink-400)]">{note}</p>
      ) : null}

      <p className="text-center text-[12px] text-[var(--color-ink-400)]">
        <Link to="/login" className="font-medium text-[var(--color-accent-400)] hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

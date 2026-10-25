import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, Info, Loader2, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { useToast } from '../lib/app-context';

/* ---------------------------------------------------------------- button -- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--color-accent-500)] text-white hover:bg-[var(--color-accent-600)] shadow-[0_1px_0_0_rgba(255,255,255,0.12)_inset]',
  secondary:
    'bg-[var(--color-ink-750)] text-[var(--color-ink-100)] hover:bg-[var(--color-ink-700)] border border-[var(--color-ink-600)]',
  ghost:
    'bg-transparent text-[var(--color-ink-200)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-ink-100)]',
  outline:
    'bg-transparent text-[var(--color-ink-100)] border border-[var(--color-ink-600)] hover:border-[var(--color-ink-500)] hover:bg-[var(--color-ink-850)]',
  danger:
    'bg-[var(--color-danger-500)]/12 text-[var(--color-danger-500)] border border-[var(--color-danger-500)]/35 hover:bg-[var(--color-danger-500)]/20',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-[var(--radius-sm)]',
  md: 'h-9.5 px-4 text-sm gap-2 rounded-[var(--radius-sm)]',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-[var(--radius-md)]',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', loading, icon, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center font-medium transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

/* ------------------------------------------------------------------ card -- */

export function Card({
  className,
  children,
  ...props
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('surface-raised p-5', className)} {...props}>
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold tracking-tight text-[var(--color-ink-100)]">
          {title}
        </h3>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-ink-300)]">
            {description}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/* ----------------------------------------------------------------- inputs -- */

export function Label({
  children,
  htmlFor,
  hint,
}: {
  children: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 flex items-baseline justify-between gap-3 text-[13px] font-medium text-[var(--color-ink-200)]"
    >
      <span>{children}</span>
      {hint ? (
        <span className="text-[11px] font-normal text-[var(--color-ink-400)]">{hint}</span>
      ) : null}
    </label>
  );
}

const FIELD_BASE =
  'w-full rounded-[var(--radius-sm)] border bg-[var(--color-ink-850)] px-3 text-sm text-[var(--color-ink-100)] placeholder:text-[var(--color-ink-400)] transition-colors focus:border-[var(--color-accent-500)] focus:outline-none disabled:opacity-60';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        FIELD_BASE,
        'h-9.5',
        invalid ? 'border-[var(--color-danger-500)]/60' : 'border-[var(--color-ink-700)]',
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(FIELD_BASE, 'min-h-24 resize-y border-[var(--color-ink-700)] py-2', className)}
      {...props}
    />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select
        ref={ref}
        className={cn(FIELD_BASE, 'h-9.5 border-[var(--color-ink-700)] pr-8', className)}
        {...props}
      >
        {children}
      </select>
    );
  },
);

export function FieldError({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p className="mt-1.5 text-[12px] text-[var(--color-danger-500)]">{children}</p>;
}

export function FieldHelp({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--color-ink-400)]">{children}</p>
  );
}

/* ---------------------------------------------------------------- switch -- */

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <label
          htmlFor={id}
          className="cursor-pointer text-[13px] font-medium text-[var(--color-ink-100)]"
        >
          {label}
        </label>
        {description ? (
          <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--color-ink-400)]">
            {description}
          </p>
        ) : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-50',
          checked
            ? 'border-[var(--color-accent-500)] bg-[var(--color-accent-500)]'
            : 'border-[var(--color-ink-600)] bg-[var(--color-ink-750)]',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-3.5 rounded-full bg-white transition-transform',
            checked ? 'translate-x-4.5' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------- badge -- */

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--color-ink-750)] text-[var(--color-ink-200)] border-[var(--color-ink-600)]',
  accent:
    'bg-[var(--color-accent-500)]/12 text-[var(--color-accent-400)] border-[var(--color-accent-500)]/30',
  success:
    'bg-[var(--color-success-500)]/12 text-[var(--color-success-500)] border-[var(--color-success-500)]/30',
  warning:
    'bg-[var(--color-warning-500)]/12 text-[var(--color-warning-500)] border-[var(--color-warning-500)]/30',
  danger:
    'bg-[var(--color-danger-500)]/12 text-[var(--color-danger-500)] border-[var(--color-danger-500)]/30',
  info: 'bg-[var(--color-info-500)]/12 text-[var(--color-info-500)] border-[var(--color-info-500)]/30',
};

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-wide',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function statusTone(status: string): BadgeTone {
  switch (status) {
    case 'completed':
    case 'connected':
    case 'configured':
    case 'active':
    case 'ok':
      return 'success';
    case 'running':
    case 'processing':
    case 'queued':
    case 'unverified':
      return 'info';
    case 'paused':
    case 'expired':
    case 'retryable':
    case 'degraded':
      return 'warning';
    case 'failed':
    case 'invalid':
    case 'revoked':
    case 'error':
    case 'unavailable':
      return 'danger';
    default:
      return 'neutral';
  }
}

/* ------------------------------------------------------------------ tabs -- */

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
}: {
  tabs: Array<{ value: T; label: string; count?: number }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        'flex gap-1 overflow-x-auto border-b border-[var(--color-ink-700)] pb-px',
        className,
      )}
    >
      {tabs.map((tab) => (
        <button
          key={tab.value}
          role="tab"
          aria-selected={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={cn(
            'relative whitespace-nowrap rounded-t-[var(--radius-sm)] px-3 py-2 text-[13px] font-medium transition-colors',
            value === tab.value
              ? 'text-[var(--color-ink-100)]'
              : 'text-[var(--color-ink-400)] hover:text-[var(--color-ink-200)]',
          )}
        >
          {tab.label}
          {typeof tab.count === 'number' ? (
            <span className="ml-1.5 text-[11px] text-[var(--color-ink-400)]">{tab.count}</span>
          ) : null}
          {value === tab.value ? (
            <span className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-[var(--color-accent-500)]" />
          ) : null}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- dialog -- */

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'fade-in relative w-full rounded-[var(--radius-xl)] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] p-6 shadow-2xl',
          width,
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-6">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-[var(--color-ink-100)]">
              {title}
            </h2>
            {description ? (
              <p className="mt-1 text-[13px] leading-relaxed text-[var(--color-ink-300)]">
                {description}
              </p>
            ) : null}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-[var(--radius-xs)] p-1 text-[var(--color-ink-400)] hover:bg-[var(--color-ink-800)] hover:text-[var(--color-ink-100)]"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto">{children}</div>
        {footer ? <div className="mt-6 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/* -------------------------------------------------------------- feedback -- */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} aria-hidden />;
}

export function SkeletonCard() {
  return (
    <div className="surface-raised space-y-3 p-5">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-3 w-2/3" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-[var(--color-ink-700)] px-6 py-14 text-center',
        className,
      )}
    >
      {icon ? <div className="mb-3 text-[var(--color-ink-500)]">{icon}</div> : null}
      <h3 className="text-[14px] font-medium text-[var(--color-ink-100)]">{title}</h3>
      {description ? (
        <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-[var(--color-ink-400)]">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-danger-500)]/30 bg-[var(--color-danger-500)]/8 p-4">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-danger-500)]" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-relaxed text-[var(--color-ink-100)]">{message}</p>
        {onRetry ? (
          <Button size="sm" variant="ghost" className="mt-2 -ml-2" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ProgressBar({
  value,
  tone = 'accent',
  className,
}: {
  value: number;
  tone?: 'accent' | 'success' | 'danger';
  className?: string;
}) {
  const colour =
    tone === 'success'
      ? 'var(--color-success-500)'
      : tone === 'danger'
        ? 'var(--color-danger-500)'
        : 'var(--color-accent-500)';
  return (
    <div
      className={cn(
        'h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-ink-750)]',
        className,
      )}
      role="progressbar"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{
          width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`,
          background: colour,
        }}
      />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-[var(--color-ink-400)]', className)} />;
}

/* ---------------------------------------------------------------- toaster -- */

export function Toaster() {
  const { toasts, dismiss } = useToast();

  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
      {toasts.map((toast) => {
        const Icon =
          toast.tone === 'success'
            ? Check
            : toast.tone === 'error'
              ? AlertTriangle
              : toast.tone === 'warning'
                ? AlertTriangle
                : Info;
        const colour =
          toast.tone === 'success'
            ? 'var(--color-success-500)'
            : toast.tone === 'error' || toast.tone === 'warning'
              ? 'var(--color-warning-500)'
              : 'var(--color-info-500)';

        return (
          <div
            key={toast.id}
            role="status"
            className="pointer-events-auto fade-in flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-ink-700)] bg-[var(--color-ink-850)] p-3.5 shadow-xl"
          >
            <Icon className="mt-0.5 size-4 shrink-0" style={{ color: colour }} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium leading-snug text-[var(--color-ink-100)]">
                {toast.title}
              </p>
              {toast.description ? (
                <p className="mt-0.5 break-words text-[12px] leading-relaxed text-[var(--color-ink-400)]">
                  {toast.description}
                </p>
              ) : null}
            </div>
            <button
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss"
              className="rounded p-0.5 text-[var(--color-ink-500)] hover:text-[var(--color-ink-200)]"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

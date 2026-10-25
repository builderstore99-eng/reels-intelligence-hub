import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Link2, PlugZap, ShieldCheck, Unplug } from 'lucide-react';
import { api } from '../lib/api';
import { useErrorToast, useToast } from '../lib/app-context';
import { PageHeader } from '../components/layout';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  ErrorState,
  SkeletonCard,
  statusTone,
} from '../components/ui';
import { formatDateTime, relativeTime } from '../lib/utils';

export default function AccountsPage() {
  const queryClient = useQueryClient();
  const errorToast = useErrorToast();
  const { push } = useToast();

  const integrations = useQuery({
    queryKey: ['integrations'],
    queryFn: () => api.integrations.list(),
  });

  async function connect() {
    try {
      const { data } = await api.integrations.connect();
      // A full-page navigation is correct here: it is an OAuth consent screen.
      window.location.href = data.authorizeUrl;
    } catch (error) {
      errorToast(error);
    }
  }

  async function disconnect(id: string) {
    if (!window.confirm('Disconnect this account? Stored credentials are deleted immediately.'))
      return;
    try {
      await api.integrations.disconnect(id);
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
      push({ tone: 'success', title: 'Account disconnected' });
    } catch (error) {
      errorToast(error);
    }
  }

  async function test(id: string) {
    try {
      const { data } = await api.integrations.test(id);
      push({ tone: data.ok ? 'success' : 'warning', title: data.message });
      void queryClient.invalidateQueries({ queryKey: ['integrations'] });
    } catch (error) {
      errorToast(error);
    }
  }

  if (integrations.isLoading) return <SkeletonCard />;
  if (integrations.isError) {
    return (
      <ErrorState
        message="Connected accounts could not load."
        onRetry={() => void integrations.refetch()}
      />
    );
  }

  const data = integrations.data!.data;

  return (
    <div>
      <PageHeader
        title="Connected Accounts"
        subtitle="Authorised Instagram accounts. Tokens are encrypted at rest and never leave the server."
        action={
          <Button
            variant="primary"
            icon={<Link2 className="size-4" />}
            onClick={() => void connect()}
          >
            Connect Instagram
          </Button>
        }
      />

      {!data.instagramConfigured ? (
        <div className="mb-5 flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-warning-500)]/30 bg-[var(--color-warning-500)]/8 p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-warning-500)]" />
          <div>
            <p className="text-[13px] font-medium text-[var(--color-ink-100)]">
              Instagram is not configured on this deployment
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-ink-300)]">
              An administrator must set <code>INSTAGRAM_APP_ID</code>,{' '}
              <code>INSTAGRAM_APP_SECRET</code> and <code>INSTAGRAM_REDIRECT_URI</code>. Until then,
              profile research cannot run against real Instagram content. Demo mode, if enabled, is
              clearly labelled and returns synthetic records only.
            </p>
          </div>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div>
          {data.accounts.length === 0 ? (
            <EmptyState
              icon={<PlugZap className="size-6" />}
              title="No connected accounts"
              description="Connect an Instagram Business or Creator account to authorise profile research. Personal accounts and private profiles are not supported by the official API."
              action={
                <Button
                  variant="primary"
                  onClick={() => void connect()}
                  disabled={!data.instagramConfigured}
                >
                  Connect Instagram
                </Button>
              }
            />
          ) : (
            <div className="space-y-3">
              {data.accounts.map((account) => (
                <Card key={account.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-[var(--color-ink-100)]">
                        {account.displayName ??
                          account.providerAccountIdentifier ??
                          'Instagram account'}
                      </p>
                      <p className="text-[11px] text-[var(--color-ink-500)]">
                        {account.provider} · id {account.providerAccountIdentifier ?? 'unknown'}
                      </p>
                    </div>
                    <Badge tone={statusTone(account.status)}>{account.status}</Badge>
                  </div>

                  <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                    <div>
                      <dt className="text-[var(--color-ink-500)]">Last success</dt>
                      <dd className="text-[var(--color-ink-200)]">
                        {relativeTime(account.lastSuccessfulAccess)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[var(--color-ink-500)]">Connected</dt>
                      <dd className="text-[var(--color-ink-200)]">
                        {formatDateTime(account.createdAt)}
                      </dd>
                    </div>
                  </dl>

                  {account.grantedPermissions.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {account.grantedPermissions.map((permission) => (
                        <Badge key={permission} tone="neutral">
                          {permission}
                        </Badge>
                      ))}
                    </div>
                  ) : null}

                  {account.lastError ? (
                    <p className="mt-2 rounded-[var(--radius-xs)] border border-[var(--color-danger-500)]/25 bg-[var(--color-danger-500)]/8 px-2 py-1.5 text-[11px] leading-relaxed text-[var(--color-ink-200)]">
                      {account.lastError}
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => void test(account.id)}>
                      Test access
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          const { data: result } = await api.integrations.reauthorize(account.id);
                          push({ tone: 'info', title: result.message });
                        } catch (error) {
                          errorToast(error);
                        }
                      }}
                    >
                      Reauthorise
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      icon={<Unplug className="size-3" />}
                      onClick={() => void disconnect(account.id)}
                    >
                      Disconnect
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="How authorisation works" />
            <ol className="space-y-2 text-[12px] leading-relaxed text-[var(--color-ink-300)]">
              <li>1. You are redirected to Instagram's own consent screen.</li>
              <li>2. Instagram returns a single-use code to our callback URL.</li>
              <li>3. The Worker exchanges it for an access token.</li>
              <li>4. The token is encrypted with AES-256-GCM before it is stored.</li>
              <li>5. Only the Worker can decrypt it, and only to call the Graph API.</li>
            </ol>
          </Card>

          <Card>
            <CardHeader title="What we never do" />
            <ul className="space-y-1.5 text-[12px] leading-relaxed text-[var(--color-ink-400)]">
              {[
                'Ask for your Instagram password — there is no endpoint that accepts one.',
                'Store session cookies as an access method.',
                'Rotate accounts to get around a rate limit or a block.',
                'Retry a 403 in the hope a different identity succeeds.',
              ].map((line) => (
                <li key={line} className="flex gap-2">
                  <ShieldCheck className="mt-0.5 size-3 shrink-0 text-[var(--color-success-500)]" />
                  {line}
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              title="Callback URL"
              description="This exact value must be registered with Meta."
            />
            <code className="block break-all rounded-[var(--radius-xs)] bg-[var(--color-ink-850)] p-2 text-[11px] text-[var(--color-ink-300)]">
              {data.redirectUri ?? 'Not configured'}
            </code>
          </Card>
        </div>
      </div>
    </div>
  );
}

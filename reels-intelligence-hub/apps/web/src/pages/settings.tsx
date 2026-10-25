import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Loader2,
  Lock,
  Save,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { ApiKeyRecord } from '@rih/shared';
import { api, ApiError } from '../lib/api';
import { useAuth, useErrorToast, useToast } from '../lib/app-context';
import { PageHeader } from '../components/layout';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  ErrorState,
  FieldError,
  FieldHelp,
  Input,
  Label,
  Select,
  SkeletonCard,
  Switch,
  Tabs,
  statusTone,
} from '../components/ui';
import { relativeTime } from '../lib/utils';

type Tab =
  'general' | 'ai' | 'api-keys' | 'processing' | 'storage' | 'integrations' | 'notifications';

const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'general', label: 'General' },
  { value: 'ai', label: 'AI' },
  { value: 'api-keys', label: 'API Keys' },
  { value: 'processing', label: 'Processing' },
  { value: 'storage', label: 'Storage' },
  { value: 'integrations', label: 'Integrations' },
  { value: 'notifications', label: 'Notifications' },
];

export default function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const initial = (params.get('tab') as Tab | null) ?? 'general';
  const [tab, setTab] = useState<Tab>(
    TABS.some((entry) => entry.value === initial) ? initial : 'general',
  );

  useEffect(() => {
    const next = params.get('tab');
    if (next && TABS.some((entry) => entry.value === next)) setTab(next as Tab);
  }, [params]);

  function changeTab(next: Tab) {
    setTab(next);
    setParams({ tab: next }, { replace: true });
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Preferences, provider credentials, processing policy and data controls for this account."
      />

      <Tabs className="mb-6" tabs={TABS} value={tab} onChange={changeTab} />

      {tab === 'general' ? <GeneralTab /> : null}
      {tab === 'ai' ? <AiTab /> : null}
      {tab === 'api-keys' ? <ApiKeysTab /> : null}
      {tab === 'processing' ? <ProcessingTab /> : null}
      {tab === 'storage' ? <StorageTab /> : null}
      {tab === 'integrations' ? <IntegrationsTab /> : null}
      {tab === 'notifications' ? <NotificationsTab /> : null}
    </div>
  );
}

/* --------------------------------------------------------------- helpers -- */

function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api.settings.get() });
}

function useSettingsSave() {
  const queryClient = useQueryClient();
  const { push } = useToast();
  const errorToast = useErrorToast();

  return useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.settings.update(patch),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      push({ tone: 'success', title: 'Settings saved' });
    },
    onError: (error) => errorToast(error),
  });
}

/* --------------------------------------------------------------- general -- */

function GeneralTab() {
  const settings = useSettings();
  const save = useSettingsSave();
  const { refresh } = useAuth();
  const [displayName, setDisplayName] = useState('');

  useEffect(() => {
    if (settings.data) setDisplayName(settings.data.data.general.displayName);
  }, [settings.data]);

  if (settings.isLoading) return <SkeletonCard />;
  if (settings.isError) return <ErrorState message="Settings could not load." />;

  const general = settings.data!.data.general;

  return (
    <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
      <Card>
        <CardHeader title="Profile" description="How you appear inside the workspace." />
        <div className="space-y-4">
          <div>
            <Label htmlFor="display-name">Display name</Label>
            <Input
              id="display-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="theme">Theme</Label>
              <Select
                id="theme"
                defaultValue={general.theme}
                onChange={(event) =>
                  save.mutate({ general: { ...general, theme: event.target.value } })
                }
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
                <option value="system">Match system</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="language">Language</Label>
              <Select id="language" defaultValue={general.language}>
                <option value="en">English</option>
                <option value="hi">हिन्दी</option>
                <option value="ta">தமிழ்</option>
                <option value="te">తెలుగు</option>
                <option value="bn">বাংলা</option>
              </Select>
              <FieldHelp>
                Interface copy is currently English only; this is stored for future use.
              </FieldHelp>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="collection-behaviour">Default collection behaviour</Label>
              <Select
                id="collection-behaviour"
                defaultValue={general.defaultCollectionBehavior}
                onChange={(event) =>
                  save.mutate({
                    general: { ...general, defaultCollectionBehavior: event.target.value },
                  })
                }
              >
                <option value="reuse">Reuse an existing collection for the same source</option>
                <option value="always_new">Always create a new collection</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="summary-depth">Default summary depth</Label>
              <Select
                id="summary-depth"
                defaultValue={general.defaultSummaryDepth}
                onChange={(event) =>
                  save.mutate({ general: { ...general, defaultSummaryDepth: event.target.value } })
                }
              >
                <option value="brief">Brief</option>
                <option value="standard">Standard</option>
                <option value="deep">Deep</option>
              </Select>
            </div>
          </div>

          <Button
            variant="primary"
            icon={<Save className="size-4" />}
            loading={save.isPending}
            onClick={async () => {
              save.mutate({ general: { ...general, displayName } });
              await refresh();
            }}
          >
            Save changes
          </Button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Account" />
        <dl className="space-y-2 text-[12px]">
          <Row label="Signed in as" value={settings.data!.data.general.displayName} />
          <Row label="Default provider" value={settings.data!.data.ai.defaultProvider} />
          <Row label="Text model" value={settings.data!.data.ai.textModel} />
        </dl>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------- AI -- */

function AiTab() {
  const settings = useSettings();
  const catalogue = useQuery({
    queryKey: ['provider-catalogue'],
    queryFn: () => api.settings.providers(),
  });
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api.settings.apiKeys.list() });
  const save = useSettingsSave();

  if (settings.isLoading || catalogue.isLoading) return <SkeletonCard />;
  if (settings.isError || catalogue.isError)
    return <ErrorState message="AI settings could not load." />;

  const ai = settings.data!.data.ai;
  const models = catalogue.data!.data.models;
  const configured = new Set(
    (keys.data?.data ?? []).filter((k) => k.status !== 'missing').map((k) => k.provider),
  );

  function modelsFor(capability: string) {
    return models.filter((model) => model.capabilities.includes(capability));
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Models"
          description="Each selection is checked against the model's declared capabilities before use — a text-only model can never be asked to transcribe."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="text-model">Text & summarisation</Label>
            <Select
              id="text-model"
              defaultValue={ai.textModel}
              onChange={(event) => save.mutate({ ai: { ...ai, textModel: event.target.value } })}
            >
              {modelsFor('text').map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} ({model.provider})
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="vision-model">Vision</Label>
            <Select
              id="vision-model"
              defaultValue={ai.visionModel}
              onChange={(event) => save.mutate({ ai: { ...ai, visionModel: event.target.value } })}
            >
              {modelsFor('vision').map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} ({model.provider})
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="embedding-model">Embeddings</Label>
            <Select
              id="embedding-model"
              defaultValue={ai.embeddingModel}
              onChange={(event) =>
                save.mutate({ ai: { ...ai, embeddingModel: event.target.value } })
              }
            >
              {modelsFor('embedding').map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} ({model.provider})
                </option>
              ))}
            </Select>
            <FieldHelp>
              The index expects 768 dimensions. Changing model requires re-indexing.
            </FieldHelp>
          </div>
          <div>
            <Label htmlFor="transcription-model">Transcription</Label>
            <Select
              id="transcription-model"
              defaultValue={ai.transcriptionModel}
              onChange={(event) =>
                save.mutate({ ai: { ...ai, transcriptionModel: event.target.value } })
              }
            >
              {modelsFor('transcription').map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} ({model.provider})
                </option>
              ))}
            </Select>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Provider readiness"
          description="Which providers have a usable credential right now."
        />
        <div className="space-y-1.5">
          {catalogue.data!.data.providers.map((provider) => (
            <div
              key={provider.slug}
              className="flex items-center justify-between rounded-[var(--radius-xs)] bg-[var(--color-ink-850)] px-3 py-2"
            >
              <div>
                <p className="text-[12px] text-[var(--color-ink-100)]">{provider.label}</p>
                <p className="text-[11px] text-[var(--color-ink-500)]">
                  {provider.capabilities.length > 0
                    ? provider.capabilities.join(', ')
                    : 'source discovery'}
                </p>
              </div>
              <Badge
                tone={
                  configured.has(provider.slug)
                    ? 'success'
                    : provider.platformConfigured
                      ? 'info'
                      : 'neutral'
                }
              >
                {configured.has(provider.slug)
                  ? 'your key'
                  : provider.platformConfigured
                    ? 'platform key'
                    : 'not configured'}
              </Badge>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- api keys -- */

/**
 * Settings → API Keys.
 *
 * The whole point of this screen is that a user can supply their own provider
 * credentials without those credentials ever coming back to the browser. The UI
 * only ever renders `maskedPreview`, and the input is cleared on save.
 */
function ApiKeysTab() {
  const queryClient = useQueryClient();
  const { push } = useToast();
  const errorToast = useErrorToast();

  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api.settings.apiKeys.list() });
  const catalogue = useQuery({
    queryKey: ['provider-catalogue'],
    queryFn: () => api.settings.providers(),
  });
  const health = useQuery({ queryKey: ['settings-health'], queryFn: () => api.settings.health() });

  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [label, setLabel] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);

  const encryptionReady = useMemo(() => {
    const check = health.data?.data.checks.find((entry) => entry.name === 'Key encryption');
    return check ? check.status === 'ok' : true;
  }, [health.data]);

  const definitions = catalogue.data?.data.providers ?? [];
  const records = keys.data?.data ?? [];

  const save = useMutation({
    mutationFn: ({
      provider,
      key,
      keyLabel,
    }: {
      provider: string;
      key: string;
      keyLabel?: string;
    }) => api.settings.apiKeys.save(provider, key, keyLabel),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      void queryClient.invalidateQueries({ queryKey: ['settings-health'] });
      void queryClient.invalidateQueries({ queryKey: ['research-readiness'] });
      push({
        tone: 'success',
        title: 'Key saved',
        description: 'Stored encrypted. Use Test to confirm the provider accepts it.',
      });
      setEditing(null);
      setValue('');
      setLabel('');
      setShowValue(false);
      setFieldError(null);
    },
    onError: (error) => {
      if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
        setFieldError(Object.values(error.fields)[0] ?? error.message);
        return;
      }
      errorToast(error);
    },
  });

  const remove = useMutation({
    mutationFn: (provider: string) => api.settings.apiKeys.remove(provider),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
      void queryClient.invalidateQueries({ queryKey: ['settings-health'] });
      void queryClient.invalidateQueries({ queryKey: ['research-readiness'] });
      push({ tone: 'success', title: 'Key deleted' });
    },
    onError: (error) => errorToast(error),
  });

  async function verify(provider: string) {
    setVerifying(provider);
    try {
      const { data } = await api.settings.apiKeys.verify(provider);
      push({
        tone: data.ok ? 'success' : data.unsupported ? 'info' : 'error',
        title: data.ok ? 'Key verified' : 'Verification failed',
        description: `${data.message} (${data.latencyMs} ms)`,
      });
      void queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    } catch (error) {
      errorToast(error);
    } finally {
      setVerifying(null);
    }
  }

  if (keys.isLoading || catalogue.isLoading) return <SkeletonCard />;
  if (keys.isError)
    return <ErrorState message="API keys could not load." onRetry={() => void keys.refetch()} />;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Your provider API keys"
          description="Bring your own keys, or use the platform's if an administrator configured one. Your key always takes precedence."
          action={
            <Badge tone={encryptionReady ? 'success' : 'danger'}>
              {encryptionReady ? 'encrypted at rest' : 'encryption unavailable'}
            </Badge>
          }
        />

        {!encryptionReady ? (
          <div className="mb-4 flex items-start gap-2.5 rounded-[var(--radius-sm)] border border-[var(--color-danger-500)]/30 bg-[var(--color-danger-500)]/8 p-3">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--color-danger-500)]" />
            <p className="text-[12px] leading-relaxed text-[var(--color-ink-200)]">
              <code>SECRETS_ENCRYPTION_KEY</code> is not set on the server, so keys cannot be
              encrypted and this screen cannot save anything. An administrator must set it with{' '}
              <code>wrangler secret put SECRETS_ENCRYPTION_KEY</code>.
            </p>
          </div>
        ) : null}

        <div className="space-y-2.5">
          {definitions.map((definition) => {
            const record = records.find((entry) => entry.provider === definition.slug);
            const isEditing = editing === definition.slug;

            return (
              <div
                key={definition.slug}
                className="rounded-[var(--radius-md)] border border-[var(--color-ink-700)] bg-[var(--color-ink-850)] p-3.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] font-medium text-[var(--color-ink-100)]">
                        {definition.label}
                      </p>
                      {definition.recommended ? <Badge tone="accent">recommended</Badge> : null}
                    </div>
                    <p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-[var(--color-ink-400)]">
                      {definition.description}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge tone={keyTone(record)}>
                      {record?.status === 'missing' || !record
                        ? 'not configured'
                        : record.fromEnvironment
                          ? 'platform key'
                          : record.status}
                    </Badge>
                  </div>
                </div>

                {record && record.status !== 'missing' ? (
                  <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--color-ink-400)]">
                    <span className="inline-flex items-center gap-1 font-mono text-[var(--color-ink-200)]">
                      <Lock className="size-3" />
                      {record.maskedPreview || '••••••••'}
                    </span>
                    {record.label ? <span>{record.label}</span> : null}
                    {record.lastVerifiedAt ? (
                      <span>verified {relativeTime(record.lastVerifiedAt)}</span>
                    ) : record.fromEnvironment ? (
                      <span>supplied by the operator</span>
                    ) : (
                      <span>not yet verified</span>
                    )}
                    {record.lastUsedAt ? (
                      <span>last used {relativeTime(record.lastUsedAt)}</span>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-2 text-[11px] text-[var(--color-ink-500)]">
                    No key stored. {definition.keyHint}.
                  </p>
                )}

                {isEditing ? (
                  <div className="mt-3 space-y-2">
                    <div>
                      <Label htmlFor={`key-${definition.slug}`} hint={definition.keyHint}>
                        {record && record.status !== 'missing'
                          ? 'New key (replaces the old one)'
                          : 'API key'}
                      </Label>
                      <div className="relative">
                        <Input
                          id={`key-${definition.slug}`}
                          type={showValue ? 'text' : 'password'}
                          value={value}
                          onChange={(event) => setValue(event.target.value)}
                          placeholder={definition.keyHint}
                          autoComplete="off"
                          spellCheck={false}
                          className="pr-10 font-mono text-[12px]"
                          invalid={Boolean(fieldError)}
                        />
                        <button
                          type="button"
                          onClick={() => setShowValue((shown) => !shown)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-ink-500)] hover:text-[var(--color-ink-200)]"
                          aria-label={showValue ? 'Hide key' : 'Show key'}
                        >
                          {showValue ? (
                            <EyeOff className="size-3.5" />
                          ) : (
                            <Eye className="size-3.5" />
                          )}
                        </button>
                      </div>
                      <FieldError>{fieldError}</FieldError>
                    </div>
                    <div>
                      <Label htmlFor={`label-${definition.slug}`} hint="optional">
                        Label
                      </Label>
                      <Input
                        id={`label-${definition.slug}`}
                        value={label}
                        onChange={(event) => setLabel(event.target.value)}
                        placeholder={`e.g. personal ${definition.label} key`}
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        loading={save.isPending}
                        disabled={value.trim().length < 16 || !encryptionReady}
                        onClick={() =>
                          save.mutate({
                            provider: definition.slug,
                            key: value,
                            ...(label.trim() ? { keyLabel: label.trim() } : {}),
                          })
                        }
                        icon={<Save className="size-3.5" />}
                      >
                        Save key
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(null);
                          setValue('');
                          setLabel('');
                          setFieldError(null);
                        }}
                      >
                        Cancel
                      </Button>
                      <a
                        href={definition.docsUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="ml-auto inline-flex items-center gap-1 self-center text-[11px] text-[var(--color-accent-400)] hover:underline"
                      >
                        Get a {definition.label} key <ExternalLink className="size-2.5" />
                      </a>
                    </div>
                  </div>
                ) : (
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<KeyRound className="size-3" />}
                      onClick={() => {
                        setEditing(definition.slug);
                        setValue('');
                        setLabel(record?.label ?? '');
                        setFieldError(null);
                      }}
                      disabled={!encryptionReady}
                    >
                      {record && record.status !== 'missing' ? 'Replace key' : 'Add key'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void verify(definition.slug)}
                      disabled={
                        verifying === definition.slug || !record || record.status === 'missing'
                      }
                      icon={
                        verifying === definition.slug ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <ShieldCheck className="size-3" />
                        )
                      }
                    >
                      Test
                    </Button>
                    {record && !record.fromEnvironment && record.status !== 'missing' ? (
                      <Button
                        size="sm"
                        variant="danger"
                        icon={<Trash2 className="size-3" />}
                        loading={remove.isPending}
                        onClick={() => {
                          if (window.confirm(`Delete the stored ${definition.label} key?`)) {
                            remove.mutate(definition.slug);
                          }
                        }}
                      >
                        Delete
                      </Button>
                    ) : null}
                    <a
                      href={definition.docsUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="ml-auto inline-flex items-center gap-1 self-center text-[11px] text-[var(--color-ink-400)] hover:text-[var(--color-accent-400)]"
                    >
                      Provider console <ExternalLink className="size-2.5" />
                    </a>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      <Card>
        <CardHeader title="How keys are protected" />
        <ul className="space-y-2 text-[12px] leading-relaxed text-[var(--color-ink-300)]">
          {[
            'Keys are encrypted with AES-256-GCM before they reach the database. The encryption key lives only in a Worker secret.',
            'No endpoint returns a key. The API response type has no field capable of holding one — only the last four characters are stored in plaintext, for display.',
            'Keys are never written to logs, error messages, or audit records. Audit entries record that a key changed, never its value.',
            'The Worker decrypts a key only at the moment it calls the provider, and only for the account that owns it.',
            'Rotating SECRETS_ENCRYPTION_KEY makes stored keys undecryptable by design; the UI then shows them as invalid and asks you to re-enter.',
            'Deleting a key removes the ciphertext immediately. There is no soft-delete copy.',
          ].map((line) => (
            <li key={line} className="flex gap-2">
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-[var(--color-success-500)]" />
              {line}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function keyTone(record: ApiKeyRecord | undefined) {
  if (!record || record.status === 'missing') return 'neutral' as const;
  if (record.fromEnvironment) return 'info' as const;
  return statusTone(record.status);
}

/* ------------------------------------------------------------ processing -- */

function ProcessingTab() {
  const settings = useSettings();
  const save = useSettingsSave();
  if (settings.isLoading) return <SkeletonCard />;
  if (settings.isError) return <ErrorState message="Processing settings could not load." />;

  const processing = settings.data!.data.processing;

  return (
    <Card>
      <CardHeader
        title="Processing policy"
        description="These values are read by the queue consumer on every attempt. Retry values are bounded — the system will never keep retrying a permanent failure."
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="concurrency">Maximum concurrency</Label>
          <Input
            id="concurrency"
            type="number"
            min={1}
            max={10}
            defaultValue={processing.maxConcurrency}
            onChange={(event) =>
              save.mutate({
                processing: { ...processing, maxConcurrency: Number(event.target.value) },
              })
            }
          />
          <FieldHelp>Queue messages processed in parallel per invocation.</FieldHelp>
        </div>
        <div>
          <Label htmlFor="retry-attempts">Maximum attempts</Label>
          <Input
            id="retry-attempts"
            type="number"
            min={1}
            max={10}
            defaultValue={processing.retryMaxAttempts}
            onChange={(event) =>
              save.mutate({
                processing: { ...processing, retryMaxAttempts: Number(event.target.value) },
              })
            }
          />
        </div>
        <div>
          <Label htmlFor="retry-base">Base retry delay (ms)</Label>
          <Input
            id="retry-base"
            type="number"
            min={500}
            max={60000}
            step={500}
            defaultValue={processing.retryBaseDelayMs}
            onChange={(event) =>
              save.mutate({
                processing: { ...processing, retryBaseDelayMs: Number(event.target.value) },
              })
            }
          />
          <FieldHelp>Exponential backoff with full jitter, capped at 10 minutes.</FieldHelp>
        </div>
        <div>
          <Label htmlFor="max-items">Default items per run</Label>
          <Input
            id="max-items"
            type="number"
            min={1}
            max={200}
            defaultValue={processing.maxItemsPerRun}
            onChange={(event) =>
              save.mutate({
                processing: { ...processing, maxItemsPerRun: Number(event.target.value) },
              })
            }
          />
        </div>
        <div>
          <Label htmlFor="cooldown">Cooldown between provider calls (s)</Label>
          <Input
            id="cooldown"
            type="number"
            min={0}
            max={86400}
            defaultValue={processing.cooldownSeconds}
            onChange={(event) =>
              save.mutate({
                processing: { ...processing, cooldownSeconds: Number(event.target.value) },
              })
            }
          />
          <FieldHelp>
            A politeness delay, not a ban-evasion mechanism. Official limits and Retry-After headers
            always take precedence.
          </FieldHelp>
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- storage -- */

function StorageTab() {
  const storage = useQuery({
    queryKey: ['settings-storage'],
    queryFn: () => api.settings.storage(),
  });
  const settings = useSettings();
  const save = useSettingsSave();
  const [purging, setPurging] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const { push } = useToast();
  const errorToast = useErrorToast();

  const purge = useMutation({
    mutationFn: () => api.settings.purge(confirmText),
    onSuccess: () => {
      push({ tone: 'success', title: 'All research data deleted' });
      setPurging(false);
      setConfirmText('');
    },
    onError: (error) => errorToast(error),
  });

  if (storage.isLoading || settings.isLoading) return <SkeletonCard />;
  if (storage.isError) return <ErrorState message="Storage settings could not load." />;

  const data = storage.data!.data;
  const retention = settings.data!.data.storage;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Retention" description="What is kept, and for how long." />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="retention-days">Retention period (days)</Label>
            <Input
              id="retention-days"
              type="number"
              min={1}
              max={3650}
              defaultValue={data.retentionDays}
              onChange={(event) =>
                save.mutate({
                  storage: { ...retention, retentionDays: Number(event.target.value) },
                })
              }
            />
          </div>
          <div className="pt-6">
            <Switch
              checked={retention.keepOriginalMedia}
              onChange={(next) =>
                save.mutate({ storage: { ...retention, keepOriginalMedia: next } })
              }
              label="Keep original media files"
              description="Off by default. Source links and derived text are always kept."
            />
          </div>
        </div>
        <p className="mt-3 rounded-[var(--radius-sm)] border border-[var(--color-ink-700)] bg-[var(--color-ink-850)] p-3 text-[11px] leading-relaxed text-[var(--color-ink-400)]">
          {data.note}
        </p>
      </Card>

      <Card>
        <CardHeader
          title="Delete all research"
          description="Removes every collection, item, summary, transcript, conversation, report, schedule and usage record for this account."
        />
        <Button
          variant="danger"
          icon={<Trash2 className="size-4" />}
          onClick={() => setPurging(true)}
        >
          Delete all research data
        </Button>
      </Card>

      <Dialog
        open={purging}
        onClose={() => setPurging(false)}
        title="Delete all research data"
        description="This is irreversible. Your account and settings are kept; all research is removed."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPurging(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={purge.isPending}
              disabled={confirmText !== 'DELETE ALL RESEARCH'}
              onClick={() => purge.mutate()}
            >
              Delete everything
            </Button>
          </>
        }
      >
        <div>
          <Label htmlFor="confirm-purge">
            Type <code className="text-[var(--color-ink-100)]">DELETE ALL RESEARCH</code> to confirm
          </Label>
          <Input
            id="confirm-purge"
            value={confirmText}
            onChange={(event) => setConfirmText(event.target.value)}
            placeholder="DELETE ALL RESEARCH"
          />
        </div>
      </Dialog>
    </div>
  );
}

/* ----------------------------------------------------------- integrations -- */

function IntegrationsTab() {
  const health = useQuery({ queryKey: ['settings-health'], queryFn: () => api.settings.health() });

  if (health.isLoading) return <SkeletonCard />;
  if (health.isError) {
    return (
      <ErrorState
        message="Integration health could not load."
        onRetry={() => void health.refetch()}
      />
    );
  }

  const data = health.data!.data;

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Integration health"
          description={`Environment: ${data.environment}${data.demoMode ? ' · demo mode enabled' : ''}`}
        />
        <div className="space-y-1.5">
          {data.checks.map((check) => (
            <div
              key={check.name}
              className="flex items-start justify-between gap-3 rounded-[var(--radius-xs)] bg-[var(--color-ink-850)] px-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-[12px] text-[var(--color-ink-100)]">{check.name}</p>
                <p className="text-[11px] leading-relaxed text-[var(--color-ink-400)]">
                  {check.detail}
                </p>
              </div>
              <Badge tone={statusTone(check.status)}>{check.status.replace('_', ' ')}</Badge>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Where credentials live"
          description="Platform-wide credentials are Worker secrets. Per-user credentials are managed on the API Keys tab."
        />
        <ul className="space-y-1.5 text-[12px] leading-relaxed text-[var(--color-ink-400)]">
          <li>
            <code className="text-[var(--color-ink-200)]">AUTH_SECRET</code> — signs session tokens.
          </li>
          <li>
            <code className="text-[var(--color-ink-200)]">SECRETS_ENCRYPTION_KEY</code> — encrypts
            stored provider keys.
          </li>
          <li>
            <code className="text-[var(--color-ink-200)]">INSTAGRAM_APP_ID</code> /{' '}
            <code className="text-[var(--color-ink-200)]">INSTAGRAM_APP_SECRET</code> — OAuth client
            for source discovery.
          </li>
          <li>
            Provider keys can be set per user on the API Keys tab, or platform-wide as Worker
            secrets.
          </li>
        </ul>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------- notifications -- */

function NotificationsTab() {
  const settings = useSettings();
  const save = useSettingsSave();
  if (settings.isLoading) return <SkeletonCard />;
  if (settings.isError) return <ErrorState message="Notification settings could not load." />;

  const notifications = settings.data!.data.notifications;

  return (
    <Card>
      <CardHeader
        title="Notifications"
        description="In-app notifications today. An email transport is not wired up in this build, and the UI does not pretend otherwise."
      />
      <div className="divide-y divide-[var(--color-ink-700)]">
        <Switch
          checked={notifications.jobCompletion}
          onChange={(next) =>
            save.mutate({ notifications: { ...notifications, jobCompletion: next } })
          }
          label="Job completion"
          description="When a research run finishes."
        />
        <Switch
          checked={notifications.jobFailure}
          onChange={(next) =>
            save.mutate({ notifications: { ...notifications, jobFailure: next } })
          }
          label="Job failure"
          description="When items fail permanently after retries are exhausted."
        />
        <Switch
          checked={notifications.researchUpdates}
          onChange={(next) =>
            save.mutate({ notifications: { ...notifications, researchUpdates: next } })
          }
          label="Research updates"
          description="New items discovered for a saved collection."
        />
        <Switch
          checked={notifications.reauthorizationRequests}
          onChange={(next) =>
            save.mutate({ notifications: { ...notifications, reauthorizationRequests: next } })
          }
          label="Reauthorisation requests"
          description="When a connected account's token expires."
        />
      </div>
      <div className="mt-4 max-w-xs">
        <Label htmlFor="usage-threshold">Usage threshold alert (USD)</Label>
        <Input
          id="usage-threshold"
          type="number"
          min={0}
          defaultValue={notifications.usageThresholdUsd}
          onChange={(event) =>
            save.mutate({
              notifications: { ...notifications, usageThresholdUsd: Number(event.target.value) },
            })
          }
        />
        <FieldHelp>
          An estimate based on published per-unit prices, not a billing statement.
        </FieldHelp>
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-[var(--color-ink-500)]">{label}</dt>
      <dd className="truncate text-[var(--color-ink-200)]">{value}</dd>
    </div>
  );
}

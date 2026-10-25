import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  CheckCircle2,
  Compass,
  Link2,
  MonitorPlay,
  Palette,
  Play,
  Settings as SettingsIcon,
  Sparkles,
} from 'lucide-react';
import { api, type ResearchResult } from '../lib/api';
import { useErrorToast, useToast } from '../lib/app-context';
import { PageHeader } from '../components/layout';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  FieldError,
  FieldHelp,
  Input,
  Label,
  ProgressBar,
  Select,
  Switch,
  Tabs,
} from '../components/ui';
import { pluralise } from '../lib/utils';

type Kind = 'reels' | 'designs' | 'topics';

const COPY: Record<Kind, { title: string; subtitle: string; cta: string; icon: typeof Compass }> = {
  reels: {
    title: 'Reels Search',
    subtitle:
      'Research a creator’s Reels and build a collection named after the profile. Only content this app is authorised to read is collected.',
    cta: 'Start Reels research',
    icon: MonitorPlay,
  },
  designs: {
    title: 'Design & Documents',
    subtitle:
      'Collect images, carousels and videos for visual analysis: palette, layout, hierarchy, and OCR text — observations separated from interpretation.',
    cta: 'Start design research',
    icon: Palette,
  },
  topics: {
    title: 'Topic Research',
    subtitle:
      'Describe what you want to learn. The active discovery provider searches what it is permitted to search, ranks by relevance, and explains any limitation.',
    cta: 'Start topic research',
    icon: Compass,
  },
};

export default function ResearchPage({ kind }: { kind: Kind }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pushToast = useToast();
  const errorToast = useErrorToast();

  const [source, setSource] = useState('');
  const [query, setQuery] = useState('');
  const [collectionName, setCollectionName] = useState('');
  const [useDemo, setUseDemo] = useState(false);
  const [maxItems, setMaxItems] = useState(24);
  const [summaryDepth, setSummaryDepth] = useState<'brief' | 'standard' | 'deep'>('standard');
  const [transcribe, setTranscribe] = useState(true);
  const [analyzeVisuals, setAnalyzeVisuals] = useState(true);
  const [autoTag, setAutoTag] = useState(true);
  const [reprocess, setReprocess] = useState(false);
  const [result, setResult] = useState<ResearchResult | null>(null);

  const readiness = useQuery({
    queryKey: ['research-readiness'],
    queryFn: () => api.research.readiness(),
    retry: 1,
  });

  const providers = useQuery({
    queryKey: ['research-providers'],
    queryFn: () => api.research.providers(),
    retry: 1,
  });

  // Live source validation. Debounced so typing does not hammer the API.
  const [validation, setValidation] = useState<{
    valid: boolean;
    message: string;
    canonicalUrl: string | null;
  } | null>(null);

  useEffect(() => {
    if (kind === 'topics') return;
    const term = source.trim();
    if (term.length < 2) {
      setValidation(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      api.research
        .validateSource(term)
        .then(({ data }) => {
          if (controller.signal.aborted) return;
          setValidation({
            valid: data.valid,
            message: data.message,
            canonicalUrl: data.canonicalUrl,
          });
        })
        .catch(() => {
          if (!controller.signal.aborted) setValidation(null);
        });
    }, 350);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [source, kind]);

  const demoAvailable = providers.data?.data.find((p) => p.slug === 'demo')?.available ?? false;
  const instagramAvailable =
    providers.data?.data.find((p) => p.slug === 'instagram')?.available ?? false;

  const canSubmit = useMemo(() => {
    if (kind === 'topics') return query.trim().length >= 3;
    return validation?.valid === true;
  }, [kind, query, validation]);

  const start = useMutation({
    mutationFn: async () => {
      const options = {
        maxItems,
        summaryDepth,
        transcribeAudio: transcribe,
        analyzeVisuals,
        autoTag,
        skipDuplicates: true,
        reprocessExisting: reprocess,
      };

      if (kind === 'topics') {
        return api.research.topics({
          query: query.trim(),
          ...(collectionName.trim() ? { collectionName: collectionName.trim() } : {}),
          options,
        });
      }

      const payload = {
        source: source.trim(),
        ...(collectionName.trim() ? { collectionName: collectionName.trim() } : {}),
        useDemoData: useDemo,
        options,
      };

      return kind === 'designs' ? api.research.designs(payload) : api.research.profiles(payload);
    },
    onSuccess: ({ data }) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['monitor'] });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });

      if (data.warning) {
        pushToast.push({
          tone: 'warning',
          title: 'Research finished with a warning',
          description: data.warning,
        });
      } else {
        pushToast.push({
          tone: 'success',
          title: `Discovered ${pluralise(data.discovered, 'item')}`,
          description: `${data.skipped} skipped as already saved. Processing continues in the background.`,
        });
      }
    },
    onError: (error) => errorToast(error),
  });

  const copy = COPY[kind];
  const Icon = copy.icon;
  const readinessData = readiness.data?.data;

  return (
    <div>
      <PageHeader
        title={copy.title}
        subtitle={copy.subtitle}
        badge={
          <Badge tone="accent">
            <Icon className="size-3" />
            {kind === 'topics' ? 'topic' : 'profile'}
          </Badge>
        }
      />

      {readinessData && !readinessData.aiConfigured ? (
        <div className="mb-5 flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--color-warning-500)]/30 bg-[var(--color-warning-500)]/8 p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-warning-500)]" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-[var(--color-ink-100)]">
              No AI provider key is configured
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-ink-300)]">
              Items can still be discovered and saved, but summarisation, tagging and embeddings
              will fail with a clear error until a key is added. Add one in Settings → API Keys.
            </p>
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              icon={<SettingsIcon className="size-3.5" />}
              onClick={() => navigate('/settings?tab=api-keys')}
            >
              Go to API Keys
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <Card>
          <CardHeader
            title={kind === 'topics' ? 'Research question' : 'Source'}
            description={
              kind === 'topics'
                ? 'Natural language works best. The provider decides what it can search and tells you what it cannot.'
                : 'A profile URL, an @handle, or a single post/reel link.'
            }
          />

          {kind === 'topics' ? (
            <div>
              <Label htmlFor="query" hint="3–300 characters">
                What do you want to research?
              </Label>
              <Input
                id="query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="e.g. high-converting landing pages for small businesses"
              />
              <FieldHelp>
                Examples: “AI website builders”, “modern dashboard UI”, “e-commerce marketing
                strategies”.
              </FieldHelp>
            </div>
          ) : (
            <div>
              <Label htmlFor="source" hint="profile, @handle, /p/, /reel/">
                Instagram source
              </Label>
              <div className="relative">
                <Link2 className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-ink-500)]" />
                <Input
                  id="source"
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  placeholder="https://www.instagram.com/design.inspiration/"
                  className="pl-8.5"
                  invalid={validation ? !validation.valid : false}
                />
              </div>
              {validation ? (
                <p
                  className={`mt-1.5 flex items-start gap-1.5 text-[12px] leading-relaxed ${
                    validation.valid
                      ? 'text-[var(--color-success-500)]'
                      : 'text-[var(--color-danger-500)]'
                  }`}
                >
                  {validation.valid ? (
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                  ) : (
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  )}
                  <span>{validation.message}</span>
                </p>
              ) : (
                <FieldHelp>
                  Supported:{' '}
                  <code className="text-[var(--color-ink-300)]">instagram.com/&lt;handle&gt;</code>,{' '}
                  <code className="text-[var(--color-ink-300)]">/p/&lt;code&gt;</code>,{' '}
                  <code className="text-[var(--color-ink-300)]">/reel/&lt;code&gt;</code>.
                </FieldHelp>
              )}

              {!instagramAvailable ? (
                <div className="mt-3 rounded-[var(--radius-sm)] border border-[var(--color-ink-700)] bg-[var(--color-ink-850)] p-3">
                  <p className="text-[12px] leading-relaxed text-[var(--color-ink-300)]">
                    Instagram is not configured on this deployment. An administrator must set the
                    app credentials, and you must connect an account on Connected Accounts.
                  </p>
                  {demoAvailable ? (
                    <div className="mt-2">
                      <Switch
                        checked={useDemo}
                        onChange={setUseDemo}
                        label="Use demo data instead"
                        description="Returns clearly-labelled synthetic records (source_provider = demo, example.com URLs). Never presented as Instagram content."
                      />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}

          <div className="mt-5">
            <Label htmlFor="collection-name" hint="optional">
              Collection name
            </Label>
            <Input
              id="collection-name"
              value={collectionName}
              onChange={(event) => setCollectionName(event.target.value)}
              placeholder={
                kind === 'topics' ? 'Defaults to your question' : 'Defaults to @handle for profiles'
              }
            />
            <FieldHelp>
              Collections are unique per account. Starting a second run against the same profile
              reuses the existing collection unless you name a new one.
            </FieldHelp>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="max-items">Maximum items</Label>
              <Input
                id="max-items"
                type="number"
                min={1}
                max={200}
                value={maxItems}
                onChange={(event) => setMaxItems(Number(event.target.value))}
              />
            </div>
            <div>
              <Label htmlFor="depth">Summary depth</Label>
              <Select
                id="depth"
                value={summaryDepth}
                onChange={(event) => setSummaryDepth(event.target.value as typeof summaryDepth)}
              >
                <option value="brief">Brief — two or three sentences</option>
                <option value="standard">Standard — one paragraph</option>
                <option value="deep">Deep — structured, with examples</option>
              </Select>
            </div>
          </div>

          <div className="mt-4 divide-y divide-[var(--color-ink-700)]">
            <Switch
              checked={transcribe}
              onChange={setTranscribe}
              label="Transcribe audio"
              description="Requires a transcription-capable key. Skipped when no audio is accessible."
            />
            <Switch
              checked={analyzeVisuals}
              onChange={setAnalyzeVisuals}
              label="Analyse visuals"
              description="Palette, layout and OCR text. Observations are kept separate from interpretation."
            />
            <Switch
              checked={autoTag}
              onChange={setAutoTag}
              label="Automatic topic tagging"
              description="Tags are normalised, so 'Lead-Gen' and 'lead gen' become one tag."
            />
            <Switch
              checked={reprocess}
              onChange={setReprocess}
              label="Re-process items already saved"
              description="Off by default. Duplicates are detected on the source identifier."
            />
          </div>

          <div className="mt-5 flex items-center justify-between gap-3">
            <FieldError>
              {!canSubmit && (kind === 'topics' ? query.length > 0 : source.length > 0)
                ? 'Enter a valid source before starting.'
                : undefined}
            </FieldError>
            <Button
              variant="primary"
              size="lg"
              loading={start.isPending}
              disabled={!canSubmit}
              onClick={() => start.mutate()}
              icon={<Play className="size-4" />}
            >
              {copy.cta}
            </Button>
          </div>
        </Card>

        <div className="space-y-4">
          {result ? (
            <Card>
              <CardHeader
                title="Run started"
                description="Processing continues in the background — you can close this tab."
                action={<Badge tone="success">queued</Badge>}
              />
              <div className="space-y-3">
                <div>
                  <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--color-ink-400)]">
                    <span>{result.collection.name}</span>
                    <span>
                      {result.job.completedItems}/{result.job.totalItems}
                    </span>
                  </div>
                  <ProgressBar value={result.job.progress} />
                </div>
                <dl className="grid grid-cols-2 gap-2 text-[12px]">
                  <div className="rounded-[var(--radius-xs)] bg-[var(--color-ink-850)] p-2">
                    <dt className="text-[10px] uppercase tracking-wide text-[var(--color-ink-500)]">
                      Discovered
                    </dt>
                    <dd className="tabular-nums text-[var(--color-ink-100)]">
                      {result.discovered}
                    </dd>
                  </div>
                  <div className="rounded-[var(--radius-xs)] bg-[var(--color-ink-850)] p-2">
                    <dt className="text-[10px] uppercase tracking-wide text-[var(--color-ink-500)]">
                      Skipped
                    </dt>
                    <dd className="tabular-nums text-[var(--color-ink-100)]">{result.skipped}</dd>
                  </div>
                  <div className="rounded-[var(--radius-xs)] bg-[var(--color-ink-850)] p-2">
                    <dt className="text-[10px] uppercase tracking-wide text-[var(--color-ink-500)]">
                      Provider
                    </dt>
                    <dd className="text-[var(--color-ink-100)]">{result.providerUsed}</dd>
                  </div>
                  <div className="rounded-[var(--radius-xs)] bg-[var(--color-ink-850)] p-2">
                    <dt className="text-[10px] uppercase tracking-wide text-[var(--color-ink-500)]">
                      Job
                    </dt>
                    <dd className="truncate text-[var(--color-ink-100)]">{result.job.status}</dd>
                  </div>
                </dl>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => navigate(`/collections/${result.collection.id}`)}
                  >
                    Open collection
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => navigate('/monitor')}>
                    Live monitor
                  </Button>
                </div>
              </div>
            </Card>
          ) : (
            <Card>
              <CardHeader title="What happens next" />
              <ol className="space-y-2.5 text-[12px] leading-relaxed text-[var(--color-ink-300)]">
                {[
                  'The source is validated and normalised before anything is created.',
                  'Accessible items are discovered and de-duplicated by source identifier.',
                  'Each item is queued: metadata → media → transcription → visual → summary → tags → embeddings.',
                  'Results are persisted stage by stage, so a late failure never erases earlier work.',
                  'You can watch and control every step on the Live Monitor.',
                ].map((line, index) => (
                  <li key={line} className="flex gap-2">
                    <span className="grid size-4 shrink-0 place-items-center rounded-full bg-[var(--color-ink-800)] text-[10px] text-[var(--color-ink-300)]">
                      {index + 1}
                    </span>
                    {line}
                  </li>
                ))}
              </ol>
            </Card>
          )}

          <Card>
            <CardHeader
              title="Provider capabilities"
              description="What this deployment can actually do."
            />
            {providers.isLoading ? (
              <p className="text-[12px] text-[var(--color-ink-400)]">Checking providers…</p>
            ) : (
              <div className="space-y-3">
                {(providers.data?.data ?? []).map((provider) => (
                  <div
                    key={provider.slug}
                    className="rounded-[var(--radius-sm)] border border-[var(--color-ink-700)] p-3"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <p className="text-[12px] font-medium text-[var(--color-ink-100)]">
                        {provider.label}
                      </p>
                      <Badge tone={provider.available ? 'success' : 'neutral'}>
                        {provider.available ? 'available' : 'not configured'}
                      </Badge>
                    </div>
                    <p className="text-[11px] leading-relaxed text-[var(--color-ink-400)]">
                      <span className="text-[var(--color-ink-300)]">Supports:</span>{' '}
                      {provider.supports.join('; ')}
                    </p>
                    <p className="text-[11px] leading-relaxed text-[var(--color-ink-500)]">
                      <span className="text-[var(--color-ink-400)]">Does not support:</span>{' '}
                      {provider.doesNotSupport.join('; ')}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {readinessData ? (
            <Card>
              <CardHeader title="Readiness" />
              <div className="space-y-1.5 text-[12px]">
                <Row label="Instagram" ok={readinessData.instagramConfigured} />
                <Row label="Demo data" ok={readinessData.demoEnabled} optional />
                <Row label="AI provider" ok={readinessData.aiConfigured} />
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-400)]">
                {readinessData.summary}
              </p>
            </Card>
          ) : null}
        </div>
      </div>

      {!readiness.isLoading && !readinessData ? (
        <EmptyState
          className="mt-6"
          icon={<Sparkles className="size-5" />}
          title="Readiness could not be checked"
          description="The API did not respond. Check that the Worker is running."
        />
      ) : null}

      <div className="mt-6">
        <Tabs
          tabs={[
            { value: 'reels', label: 'Reels Search' },
            { value: 'designs', label: 'Design & Documents' },
            { value: 'topics', label: 'Topic Research' },
          ]}
          value={kind}
          onChange={(next) =>
            navigate(next === 'reels' ? '/reels' : next === 'designs' ? '/designs' : '/topics')
          }
        />
      </div>
    </div>
  );
}

function Row({ label, ok, optional }: { label: string; ok: boolean; optional?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[var(--color-ink-400)]">{label}</span>
      <Badge tone={ok ? 'success' : optional ? 'neutral' : 'warning'}>
        {ok ? 'ready' : optional ? 'off' : 'missing'}
      </Badge>
    </div>
  );
}

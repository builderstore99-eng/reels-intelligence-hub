import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowRight,
  BookOpen,
  Bot,
  MessageSquare,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react';
import { formatUsd } from '@rih/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/app-context';
import { PageHeader, Section } from '../components/layout';
import { CollectionCard, JobRow, MetricCard } from '../components/shared';
import { Badge, Button, EmptyState, ErrorState, SkeletonCard, statusTone } from '../components/ui';
import { relativeTime, truncate } from '../lib/utils';

export default function DashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.dashboard(),
    refetchInterval: 20_000,
  });

  if (dashboard.isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <SkeletonCard key={index} />
          ))}
        </div>
        <SkeletonCard />
      </div>
    );
  }

  if (dashboard.isError) {
    return (
      <ErrorState
        message="The dashboard could not be loaded."
        onRetry={() => void dashboard.refetch()}
      />
    );
  }

  const data = dashboard.data!.data;
  const metrics = data.metrics;

  return (
    <div>
      <PageHeader
        title="Your Research Workspace"
        subtitle="Discover content. Extract knowledge. Build your own AI research library."
        action={
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => navigate('/reels')}
          >
            New Research
          </Button>
        }
      />

      <form
        className="mb-6"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const term = String(form.get('q') ?? '').trim();
          if (term) navigate(`/search?q=${encodeURIComponent(term)}`);
        }}
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-[var(--color-ink-500)]" />
          <input
            name="q"
            placeholder="Search creators, topics, videos, and saved research…"
            aria-label="Search your research"
            className="h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-ink-700)] bg-[var(--color-ink-900)] pl-10 pr-3 text-[14px] text-[var(--color-ink-100)] placeholder:text-[var(--color-ink-500)] focus:border-[var(--color-accent-500)] focus:outline-none"
          />
        </div>
      </form>

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Content discovered"
          value={metrics.totalDiscovered}
          hint="Items saved across every collection"
        />
        <MetricCard
          label="Items analysed"
          value={metrics.totalAnalyzed}
          hint="Summaries generated from real content"
          tone="success"
        />
        <MetricCard
          label="Collections"
          value={metrics.collections}
          hint="Active research projects"
        />
        <MetricCard
          label="Pending jobs"
          value={metrics.pendingJobs}
          hint={`${metrics.failedJobs} failed`}
          tone={metrics.failedJobs > 0 ? 'danger' : undefined}
        />
      </div>

      <Section
        title="Recent research"
        description="Your most recently active collections."
        action={
          <Link
            to="/collections"
            className="inline-flex items-center gap-1 text-[12px] text-[var(--color-accent-400)] hover:underline"
          >
            All collections <ArrowRight className="size-3" />
          </Link>
        }
      >
        {data.collections.length === 0 ? (
          <EmptyState
            icon={<BookOpen className="size-6" />}
            title="No collections yet"
            description="Start a research run from Reels Search, Design & Documents, or Topic Research. Each run creates a collection you can search and chat with."
            action={
              <Button
                variant="primary"
                onClick={() => navigate('/reels')}
                icon={<Plus className="size-4" />}
              >
                Start your first research
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.collections.map((collection) => (
              <CollectionCard key={collection.id} collection={collection} />
            ))}
          </div>
        )}
      </Section>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Section
          title="Active research jobs"
          description="Live processing state, from persisted job records."
        >
          {data.jobs.length === 0 ? (
            <EmptyState
              icon={<Activity className="size-5" />}
              title="Nothing processing"
              description="Jobs appear here while the queue is working through discovered items."
            />
          ) : (
            <div className="space-y-2.5">
              {data.jobs.map((job) => (
                <JobRow key={job.id} job={job} />
              ))}
            </div>
          )}
        </Section>

        <Section title="Recent activity" description="Pipeline events, newest first.">
          {data.events.length === 0 ? (
            <EmptyState
              icon={<Sparkles className="size-5" />}
              title="No events yet"
              description="Discovery, transcription, summarisation and retries are all logged here."
            />
          ) : (
            <div className="surface divide-y divide-[var(--color-ink-700)]">
              {data.events.slice(0, 8).map((event) => (
                <div key={event.id} className="flex items-start gap-2.5 px-3.5 py-2.5">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--color-ink-500)]" />
                  <div className="min-w-0">
                    <p className="text-[12px] leading-relaxed text-[var(--color-ink-200)]">
                      {event.message}
                    </p>
                    <p className="text-[11px] text-[var(--color-ink-500)]">
                      {event.collectionName ? `${event.collectionName} · ` : ''}
                      {relativeTime(event.createdAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Section title="Recent items" description="Newest saved content across all collections.">
          {data.items.length === 0 ? (
            <EmptyState
              icon={<Sparkles className="size-5" />}
              title="No items saved"
              description="Once a research run discovers content, items appear here with their processing status."
            />
          ) : (
            <div className="surface divide-y divide-[var(--color-ink-700)]">
              {data.items.map((item) => (
                <Link
                  key={item.id}
                  to={item.collectionId ? `/collections/${item.collectionId}` : '/collections'}
                  className="flex items-start justify-between gap-3 px-3.5 py-3 hover:bg-[var(--color-ink-850)]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[12px] text-[var(--color-ink-100)]">
                      {truncate(item.caption, 90) || 'Untitled item'}
                    </p>
                    <p className="text-[11px] text-[var(--color-ink-500)]">
                      {item.creatorIdentifier ? `@${item.creatorIdentifier}` : 'unknown'} ·{' '}
                      {item.collectionName ?? 'unfiled'}
                    </p>
                  </div>
                  <Badge tone={statusTone(item.processingStatus)}>{item.processingStatus}</Badge>
                </Link>
              ))}
            </div>
          )}
        </Section>

        <Section title="Conversations & usage" description="Your saved AI research threads.">
          <div className="space-y-2.5">
            <div className="surface flex items-center justify-between p-4">
              <div>
                <p className="text-[12px] font-medium text-[var(--color-ink-100)]">
                  AI processing spend
                </p>
                <p className="text-[11px] text-[var(--color-ink-400)]">
                  {metrics.aiCalls} metered calls, estimated
                </p>
              </div>
              <span className="text-[16px] font-semibold tabular-nums text-[var(--color-ink-100)]">
                {formatUsd(metrics.aiCostUsd)}
              </span>
            </div>

            {data.conversations.length === 0 ? (
              <EmptyState
                icon={<Bot className="size-5" />}
                title="No conversations yet"
                description="Open a collection and ask a question about the research inside it."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => navigate('/chat')}
                    icon={<MessageSquare className="size-4" />}
                  >
                    Open research chat
                  </Button>
                }
              />
            ) : (
              data.conversations.map((conversation) => (
                <Link
                  key={conversation.id}
                  to={`/chat?conversation=${conversation.id}`}
                  className="surface surface-hover flex items-center justify-between gap-3 p-3.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[12px] text-[var(--color-ink-100)]">
                      {conversation.title}
                    </p>
                    <p className="text-[11px] text-[var(--color-ink-500)]">
                      {conversation.messageCount} messages · {relativeTime(conversation.updatedAt)}
                    </p>
                  </div>
                  <Badge tone="neutral">{conversation.scopeType.replace('_', ' ')}</Badge>
                </Link>
              ))
            )}
          </div>
        </Section>
      </div>

      <p className="mt-10 text-center text-[11px] text-[var(--color-ink-500)]">
        Signed in as {user?.displayName} · all metrics are read live from your own data
      </p>
    </div>
  );
}

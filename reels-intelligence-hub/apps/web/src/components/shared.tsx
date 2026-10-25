import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  BookOpen,
  ExternalLink,
  Image as ImageIcon,
  Layers,
  MonitorPlay,
  Play,
} from 'lucide-react';
import type { Collection, ContentItem, ResearchJob, Summary } from '@rih/shared';
import { PIPELINE_STAGES } from '@rih/shared';
import { cn, formatDate, percent, pluralise, relativeTime, truncate } from '../lib/utils';
import { Badge, ProgressBar, statusTone } from './ui';

/** Collection summary card used on the dashboard and the collections grid. */
export function CollectionCard({ collection }: { collection: Collection }) {
  const analysed = collection.analyzedCount;
  const total = collection.itemCount;
  const progress = total === 0 ? 0 : analysed / total;

  return (
    <Link
      to={`/collections/${collection.id}`}
      className="surface-raised surface-hover group flex flex-col gap-3 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-xs)] bg-[var(--color-ink-800)] text-[var(--color-ink-300)]">
            {collection.collectionType === 'design_references' ? (
              <Layers className="size-4" />
            ) : collection.collectionType === 'instagram_profile' ? (
              <MonitorPlay className="size-4" />
            ) : (
              <BookOpen className="size-4" />
            )}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-medium text-[var(--color-ink-100)]">
              {collection.name}
            </p>
            <p className="truncate text-[11px] text-[var(--color-ink-400)]">
              {collection.collectionType.replace(/_/g, ' ')}
            </p>
          </div>
        </div>
        <Badge tone={statusTone(collection.status)}>{collection.status}</Badge>
      </div>

      {collection.description ? (
        <p className="line-clamp-2 text-[12px] leading-relaxed text-[var(--color-ink-400)]">
          {collection.description}
        </p>
      ) : null}

      <div className="mt-auto space-y-2">
        <div className="flex items-center justify-between text-[11px] text-[var(--color-ink-400)]">
          <span>
            {analysed}/{total} analysed
          </span>
          <span>{relativeTime(collection.lastActivityAt ?? collection.updatedAt)}</span>
        </div>
        <ProgressBar value={progress} tone={progress === 1 ? 'success' : 'accent'} />
      </div>
    </Link>
  );
}

export function contentTypeIcon(type: string) {
  switch (type) {
    case 'reel':
    case 'video':
      return <Play className="size-3.5" />;
    case 'carousel':
      return <Layers className="size-3.5" />;
    default:
      return <ImageIcon className="size-3.5" />;
  }
}

/** One content item, used in grids across collections, search and dashboard. */
export function ItemCard({
  item,
  summary,
  tags,
  onOpen,
}: {
  item: ContentItem;
  summary?: Summary | null;
  tags?: Array<{ normalizedName: string }>;
  onOpen?: () => void;
}) {
  const isDemo = item.sourceProvider === 'demo' || item.metadata['demo'] === true;

  return (
    <article className="surface-raised surface-hover flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--color-ink-400)]">
          {contentTypeIcon(item.contentType)}
          <span className="truncate">
            {item.creatorIdentifier ? `@${item.creatorIdentifier}` : 'Unknown creator'}
          </span>
          <span>·</span>
          <span className="shrink-0">{formatDate(item.publishedAt)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isDemo ? <Badge tone="warning">DEMO</Badge> : null}
          <Badge tone={statusTone(item.processingStatus)}>{item.processingStatus}</Badge>
        </div>
      </div>

      <button
        onClick={onOpen}
        className="text-left text-[13px] font-medium leading-snug text-[var(--color-ink-100)] hover:text-[var(--color-accent-400)]"
      >
        {summary?.title || truncate(item.caption, 110) || 'Untitled item'}
      </button>

      {summary?.shortSummary || item.caption ? (
        <p className="line-clamp-3 text-[12px] leading-relaxed text-[var(--color-ink-400)]">
          {summary?.shortSummary ?? item.caption}
        </p>
      ) : (
        <p className="text-[12px] italic text-[var(--color-ink-500)]">
          No caption was available. Nothing has been generated for this item yet.
        </p>
      )}

      {tags && tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {tags.slice(0, 4).map((tag) => (
            <Badge key={tag.normalizedName} tone="neutral">
              {tag.normalizedName}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="mt-auto flex items-center justify-between border-t border-[var(--color-ink-700)] pt-2.5">
        <button
          onClick={onOpen}
          className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-accent-400)] hover:text-[var(--color-accent-500)]"
        >
          Open details <ArrowUpRight className="size-3" />
        </button>
        <a
          href={item.sourceUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-[11px] text-[var(--color-ink-400)] hover:text-[var(--color-ink-200)]"
        >
          Source <ExternalLink className="size-3" />
        </a>
      </div>
    </article>
  );
}

/** The processing pipeline visualisation used on the Live Monitor. */
export function StagePipeline({ job }: { job: ResearchJob }) {
  const active = job.status === 'running';
  const done = job.status === 'completed';

  return (
    <div className="flex flex-wrap items-center gap-1">
      {PIPELINE_STAGES.map((stage, index) => {
        const complete = done || (active && job.progress >= (index + 1) / PIPELINE_STAGES.length);
        return (
          <div key={stage} className="flex items-center gap-1">
            <span
              className={cn(
                'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide',
                complete
                  ? 'border-[var(--color-success-500)]/30 bg-[var(--color-success-500)]/10 text-[var(--color-success-500)]'
                  : 'border-[var(--color-ink-700)] bg-[var(--color-ink-800)] text-[var(--color-ink-500)]',
              )}
            >
              {stage.replace(/_/g, ' ')}
            </span>
            {index < PIPELINE_STAGES.length - 1 ? (
              <span className="text-[10px] text-[var(--color-ink-600)]">→</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function JobRow({
  job,
  collectionName,
  onPause,
  onResume,
  onCancel,
  onRetry,
  busy,
}: {
  job: ResearchJob;
  collectionName?: string;
  onPause?: () => void;
  onResume?: () => void;
  onCancel?: () => void;
  onRetry?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="surface p-4">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-[var(--color-ink-100)]">
            {collectionName ?? job.collectionId} · {job.jobType.replace(/_/g, ' ')}
          </p>
          <p className="text-[11px] text-[var(--color-ink-400)]">
            {pluralise(job.completedItems, 'item')} analysed · {job.failedItems} failed ·{' '}
            {job.skippedItems} skipped · {relativeTime(job.updatedAt)}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge tone={statusTone(job.status)}>{job.status}</Badge>
          <span className="text-[11px] tabular-nums text-[var(--color-ink-400)]">
            {percent(job.progress)}
          </span>
        </div>
      </div>

      <ProgressBar
        value={job.progress}
        tone={
          job.status === 'failed' ? 'danger' : job.status === 'completed' ? 'success' : 'accent'
        }
      />

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {job.status === 'running' || job.status === 'queued' ? (
          <button
            onClick={onPause}
            disabled={busy}
            className="rounded-[var(--radius-xs)] border border-[var(--color-ink-600)] px-2 py-1 text-[11px] text-[var(--color-ink-200)] hover:bg-[var(--color-ink-800)] disabled:opacity-50"
          >
            Pause
          </button>
        ) : null}
        {job.status === 'paused' ? (
          <button
            onClick={onResume}
            disabled={busy}
            className="rounded-[var(--radius-xs)] border border-[var(--color-ink-600)] px-2 py-1 text-[11px] text-[var(--color-ink-200)] hover:bg-[var(--color-ink-800)] disabled:opacity-50"
          >
            Resume
          </button>
        ) : null}
        {['queued', 'running', 'paused'].includes(job.status) ? (
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-[var(--radius-xs)] border border-[var(--color-danger-500)]/30 px-2 py-1 text-[11px] text-[var(--color-danger-500)] hover:bg-[var(--color-danger-500)]/10 disabled:opacity-50"
          >
            Cancel
          </button>
        ) : null}
        {job.status === 'failed' ? (
          <button
            onClick={onRetry}
            disabled={busy}
            className="rounded-[var(--radius-xs)] border border-[var(--color-ink-600)] px-2 py-1 text-[11px] text-[var(--color-ink-200)] hover:bg-[var(--color-ink-800)] disabled:opacity-50"
          >
            Retry failed items
          </button>
        ) : null}
      </div>

      {job.errorSummary ? (
        <p className="mt-2 rounded-[var(--radius-xs)] border border-[var(--color-danger-500)]/25 bg-[var(--color-danger-500)]/8 px-2 py-1.5 text-[11px] leading-relaxed text-[var(--color-ink-200)]">
          {job.errorSummary}
        </p>
      ) : null}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: 'accent' | 'warning' | 'danger' | 'success';
}) {
  const colour =
    tone === 'warning'
      ? 'text-[var(--color-warning-500)]'
      : tone === 'danger'
        ? 'text-[var(--color-danger-500)]'
        : tone === 'success'
          ? 'text-[var(--color-success-500)]'
          : 'text-[var(--color-ink-100)]';

  return (
    <div className="surface-raised p-4">
      <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-500)]">
        {label}
      </p>
      <p className={cn('mt-1.5 text-[22px] font-semibold tabular-nums tracking-tight', colour)}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] text-[var(--color-ink-400)]">{hint}</p> : null}
    </div>
  );
}

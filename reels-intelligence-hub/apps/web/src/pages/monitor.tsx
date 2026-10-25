import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { useErrorToast } from '../lib/app-context';
import { PageHeader } from '../components/layout';
import { JobRow, MetricCard, StagePipeline } from '../components/shared';
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
import { relativeTime } from '../lib/utils';

export default function MonitorPage() {
  const queryClient = useQueryClient();
  const errorToast = useErrorToast();
  const [busyJob, setBusyJob] = useState<string | null>(null);

  const monitor = useQuery({
    queryKey: ['monitor'],
    queryFn: () => api.jobs.monitor(),
    refetchInterval: 4000,
  });

  async function act(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry') {
    setBusyJob(jobId);
    try {
      await api.jobs[action](jobId);
      await queryClient.invalidateQueries({ queryKey: ['monitor'] });
    } catch (error) {
      errorToast(error);
    } finally {
      setBusyJob(null);
    }
  }

  if (monitor.isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <SkeletonCard key={index} />
        ))}
      </div>
    );
  }

  if (monitor.isError) {
    return (
      <ErrorState message="The monitor could not load." onRetry={() => void monitor.refetch()} />
    );
  }

  const data = monitor.data!.data;
  const active = data.jobs.filter((job) => ['queued', 'running', 'paused'].includes(job.status));
  const finished = data.jobs.filter((job) => !['queued', 'running', 'paused'].includes(job.status));

  return (
    <div>
      <PageHeader
        title="Live Processing Monitor"
        subtitle="Every number here is derived from persisted job records, not from browser state. Refreshing the page changes nothing."
        badge={<Badge tone="info">polling every 4s</Badge>}
        action={
          <Button
            variant="secondary"
            icon={<RefreshCw className="size-4" />}
            onClick={() => void monitor.refetch()}
          >
            Refresh
          </Button>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Discovered" value={data.totalDiscovered} hint="All job items" />
        <MetricCard
          label="Processed"
          value={data.processed}
          hint="Completed successfully"
          tone="success"
        />
        <MetricCard label="Waiting" value={data.waiting} hint="Queued, not started" />
        <MetricCard label="Processing" value={data.processing} hint="In flight now" tone="accent" />
        <MetricCard
          label="Failed"
          value={data.failed}
          hint="Exhausted retries"
          tone={data.failed > 0 ? 'danger' : undefined}
        />
        <MetricCard
          label="Retryable"
          value={data.retryable}
          hint="Scheduled for retry"
          tone={data.retryable > 0 ? 'warning' : undefined}
        />
        <MetricCard label="Skipped" value={data.skipped} hint="Duplicates or unsupported" />
        <MetricCard
          label="Rate"
          value={`${data.ratePerMinute}/min`}
          hint={
            data.estimatedRemainingMs !== null
              ? `~${Math.max(1, Math.round(data.estimatedRemainingMs / 60_000))} min remaining`
              : 'No estimate yet'
          }
        />
      </div>

      <div className="mb-6">
        <Card>
          <CardHeader
            title="Pipeline stages"
            description="Not every content type requires every stage — a caption-only item skips media, transcription and OCR."
          />
          {active[0] ? (
            <StagePipeline job={active[0]} />
          ) : (
            <p className="text-[12px] text-[var(--color-ink-400)]">
              No active job. Stage progress is shown per job when one is running.
            </p>
          )}
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 text-[14px] font-semibold text-[var(--color-ink-100)]">
            Active jobs
          </h2>
          {active.length === 0 ? (
            <EmptyState
              icon={<Activity className="size-5" />}
              title="Nothing running"
              description="Start a research run and it will appear here with live controls."
            />
          ) : (
            <div className="space-y-2.5">
              {active.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  busy={busyJob === job.id}
                  onPause={() => void act(job.id, 'pause')}
                  onResume={() => void act(job.id, 'resume')}
                  onCancel={() => void act(job.id, 'cancel')}
                  onRetry={() => void act(job.id, 'retry')}
                />
              ))}
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-2 text-[14px] font-semibold text-[var(--color-ink-100)]">
            Recent jobs
          </h2>
          {finished.length === 0 ? (
            <EmptyState
              title="No finished jobs"
              description="Completed and failed runs are listed here."
            />
          ) : (
            <div className="space-y-2.5">
              {finished.map((job) => (
                <div key={job.id} className="surface p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-[12px] text-[var(--color-ink-100)]">
                        {job.jobType.replace(/_/g, ' ')}
                      </p>
                      <p className="text-[11px] text-[var(--color-ink-500)]">
                        {job.completedItems}/{job.totalItems} · {job.failedItems} failed ·{' '}
                        {relativeTime(job.updatedAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge tone={statusTone(job.status)}>{job.status}</Badge>
                      {job.status === 'failed' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyJob === job.id}
                          onClick={() => void act(job.id, 'retry')}
                        >
                          Retry
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {job.errorSummary ? (
                    <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-ink-400)]">
                      {job.errorSummary}
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

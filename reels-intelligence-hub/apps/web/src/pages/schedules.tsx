import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Play, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useErrorToast, useToast } from '../lib/app-context';
import { PageHeader } from '../components/layout';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  Label,
  Select,
  SkeletonCard,
  Switch,
  statusTone,
} from '../components/ui';
import { formatDateTime, relativeTime } from '../lib/utils';

export default function SchedulesPage() {
  const queryClient = useQueryClient();
  const errorToast = useErrorToast();
  const { push } = useToast();

  const [creating, setCreating] = useState(false);
  const [collectionId, setCollectionId] = useState('');
  const [cadence, setCadence] = useState<'daily' | 'weekly' | 'custom'>('weekly');
  const [cron, setCron] = useState('');
  const [maxItems, setMaxItems] = useState(24);
  const [autoProcess, setAutoProcess] = useState(true);
  const [notify, setNotify] = useState(true);

  const schedules = useQuery({ queryKey: ['schedules'], queryFn: () => api.schedules.list() });
  const collections = useQuery({
    queryKey: ['collections', 'schedule-picker'],
    queryFn: () => api.collections.list({ pageSize: 100 }),
  });

  const create = useMutation({
    mutationFn: () =>
      api.schedules.create({
        collectionId,
        cadence,
        ...(cron ? { cron } : {}),
        maxItemsPerRun: maxItems,
        autoProcess,
        notify,
        enabled: true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
      push({ tone: 'success', title: 'Schedule created' });
      setCreating(false);
    },
    onError: (error) => errorToast(error),
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.schedules.toggle(id, enabled),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['schedules'] }),
    onError: (error) => errorToast(error),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.schedules.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
      push({ tone: 'success', title: 'Schedule deleted' });
    },
    onError: (error) => errorToast(error),
  });

  const runNow = useMutation({
    mutationFn: (id: string) => api.schedules.run(id),
    onSuccess: ({ data }) => {
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
      void queryClient.invalidateQueries({ queryKey: ['monitor'] });
      push({
        tone: 'success',
        title: 'Run triggered',
        description: `${data.discovered} items discovered.`,
      });
    },
    onError: (error) => errorToast(error),
  });

  const rows = schedules.data?.data ?? [];
  const collectionOptions = collections.data?.data ?? [];

  return (
    <div>
      <PageHeader
        title="Scheduled Research"
        subtitle="Periodic re-checks of a collection. Each run respects account authorisation, provider limits, and duplicate detection."
        action={
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => setCreating(true)}
          >
            New schedule
          </Button>
        }
      />

      {schedules.isLoading ? (
        <SkeletonCard />
      ) : schedules.isError ? (
        <ErrorState message="Schedules could not load." onRetry={() => void schedules.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<CalendarClock className="size-6" />}
          title="No schedules"
          description="A schedule re-runs discovery for a profile collection on a cadence you choose, so new posts are picked up without manual work."
          action={
            <Button variant="primary" onClick={() => setCreating(true)}>
              Create a schedule
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          {rows.map((schedule) => {
            const collection = collectionOptions.find((c) => c.id === schedule.collectionId);
            return (
              <Card key={schedule.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-[var(--color-ink-100)]">
                      {collection?.name ?? schedule.collectionId}
                    </p>
                    <p className="text-[11px] text-[var(--color-ink-500)]">
                      {schedule.cadence}
                      {schedule.cron ? ` · ${schedule.cron}` : ''} · max {schedule.maxItemsPerRun}{' '}
                      items/run
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={schedule.enabled ? 'success' : 'neutral'}>
                      {schedule.enabled ? 'enabled' : 'paused'}
                    </Badge>
                    {schedule.lastRunStatus ? (
                      <Badge tone={statusTone(schedule.lastRunStatus.split(':')[0] ?? '')}>
                        {schedule.lastRunStatus}
                      </Badge>
                    ) : null}
                  </div>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3">
                  <div>
                    <dt className="text-[var(--color-ink-500)]">Last run</dt>
                    <dd className="text-[var(--color-ink-200)]">
                      {relativeTime(schedule.lastRunAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-ink-500)]">Next run</dt>
                    <dd className="text-[var(--color-ink-200)]">
                      {formatDateTime(schedule.nextRunAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-ink-500)]">Auto-process</dt>
                    <dd className="text-[var(--color-ink-200)]">
                      {schedule.autoProcess ? 'yes' : 'no'}
                    </dd>
                  </div>
                </dl>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Play className="size-3" />}
                    loading={runNow.isPending}
                    onClick={() => runNow.mutate(schedule.id)}
                  >
                    Run now
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => toggle.mutate({ id: schedule.id, enabled: !schedule.enabled })}
                  >
                    {schedule.enabled ? 'Pause schedule' : 'Resume schedule'}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 className="size-3" />}
                    onClick={() => remove.mutate(schedule.id)}
                  >
                    Delete
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Card className="mt-6">
        <CardHeader
          title="How scheduling runs"
          description="A Cloudflare Cron Trigger fires daily at 03:00 UTC. It enqueues work for schedules whose next_run_at has passed, then hands each item to the same queue as a manual run — so a slow run can never exceed the cron's CPU budget."
        />
        <p className="text-[11px] leading-relaxed text-[var(--color-ink-500)]">
          Incremental discovery is only as good as the provider allows. The Instagram Graph API has
          no cursor for “posts since date” on every endpoint, so a scheduled run re-lists recent
          media and relies on duplicate detection by source identifier.
        </p>
      </Card>

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New schedule"
        description="Choose a collection and a cadence."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!collectionId}
              onClick={() => create.mutate()}
            >
              Create schedule
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="s-collection">Collection</Label>
            <Select
              id="s-collection"
              value={collectionId}
              onChange={(event) => setCollectionId(event.target.value)}
            >
              <option value="">Choose…</option>
              {collectionOptions.map((collection) => (
                <option key={collection.id} value={collection.id}>
                  {collection.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="s-cadence">Cadence</Label>
            <Select
              id="s-cadence"
              value={cadence}
              onChange={(event) => setCadence(event.target.value as typeof cadence)}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="custom">Custom cron</option>
            </Select>
          </div>
          {cadence === 'custom' ? (
            <div>
              <Label htmlFor="s-cron">Cron expression</Label>
              <Input
                id="s-cron"
                value={cron}
                onChange={(event) => setCron(event.target.value)}
                placeholder="0 3 * * *"
              />
            </div>
          ) : null}
          <div>
            <Label htmlFor="s-max">Maximum items per run</Label>
            <Input
              id="s-max"
              type="number"
              min={1}
              max={200}
              value={maxItems}
              onChange={(event) => setMaxItems(Number(event.target.value))}
            />
          </div>
          <div className="divide-y divide-[var(--color-ink-700)]">
            <Switch
              checked={autoProcess}
              onChange={setAutoProcess}
              label="Process discovered items automatically"
            />
            <Switch checked={notify} onChange={setNotify} label="Notify on completion" />
          </div>
        </div>
      </Dialog>
    </div>
  );
}

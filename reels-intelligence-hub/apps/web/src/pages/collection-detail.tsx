import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Bot,
  Copy,
  FileText,
  LayoutGrid,
  List,
  MessageSquarePlus,
  MoreHorizontal,
  Trash2,
  Wand2,
} from 'lucide-react';
import { api, ApiError, type CollectionItem } from '../lib/api';
import { useErrorToast, useToast } from '../lib/app-context';
import { PageHeader } from '../components/layout';
import { ItemCard, JobRow } from '../components/shared';
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
  Tabs,
  Textarea,
  statusTone,
} from '../components/ui';
import { formatDateTime, pluralise, relativeTime } from '../lib/utils';

type Tab =
  'overview' | 'items' | 'summaries' | 'transcripts' | 'insights' | 'chat' | 'reports' | 'activity';

export default function CollectionDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const errorToast = useErrorToast();
  const { push } = useToast();

  const [tab, setTab] = useState<Tab>('overview');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState('recent');
  const [detail, setDetail] = useState<CollectionItem | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [generatingReport, setGeneratingReport] = useState(false);
  const [reportQuestion, setReportQuestion] = useState('');
  const [activeReport, setActiveReport] = useState<{ title: string; content: string } | null>(null);

  const collection = useQuery({
    queryKey: ['collection', id],
    queryFn: () => api.collections.get(id),
    enabled: Boolean(id),
  });

  const items = useQuery({
    queryKey: ['collection-items', id, sort],
    queryFn: () => api.collections.items(id, { sort, pageSize: 60 }),
    enabled: Boolean(id),
  });

  const jobs = useQuery({
    queryKey: ['collection-jobs', id],
    queryFn: () => api.jobs.list({ collectionId: id, pageSize: 10 }),
    enabled: Boolean(id),
  });

  const reports = useQuery({
    queryKey: ['collection-reports', id],
    queryFn: () => api.collections.reports(id),
    enabled: Boolean(id) && tab === 'reports',
  });

  const rename = useMutation({
    mutationFn: () => api.collections.update(id, { name: newName.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['collection', id] });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      push({ tone: 'success', title: 'Collection renamed' });
      setRenaming(false);
    },
    onError: (error) => errorToast(error),
  });

  const duplicate = useMutation({
    mutationFn: () => api.collections.duplicate(id),
    onSuccess: ({ data }) => {
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      push({ tone: 'success', title: 'Collection duplicated' });
      navigate(`/collections/${data.id}`);
    },
    onError: (error) => errorToast(error),
  });

  const remove = useMutation({
    mutationFn: () => api.collections.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      push({ tone: 'success', title: 'Collection deleted' });
      navigate('/collections');
    },
    onError: (error) => errorToast(error),
  });

  const archive = useMutation({
    mutationFn: (status: 'active' | 'archived') => api.collections.update(id, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['collection', id] });
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
    },
    onError: (error) => errorToast(error),
  });

  const startChat = useMutation({
    mutationFn: () =>
      api.chat.create({ scopeType: 'collection', collectionId: id, title: 'Collection chat' }),
    onSuccess: ({ data }) => navigate(`/chat?conversation=${data.id}`),
    onError: (error) => errorToast(error),
  });

  const createReport = useMutation({
    mutationFn: () =>
      api.reports.create({
        collectionId: id,
        ...(reportQuestion.trim() ? { question: reportQuestion.trim() } : {}),
      }),
    onSuccess: ({ data }) => {
      setGeneratingReport(false);
      setActiveReport({ title: data.title, content: data.content });
      void queryClient.invalidateQueries({ queryKey: ['collection-reports', id] });
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        push({ tone: error.retryable ? 'warning' : 'error', title: error.message });
      } else {
        errorToast(error);
      }
    },
  });

  if (collection.isLoading) return <SkeletonCard />;
  if (collection.isError) {
    return (
      <ErrorState
        message={
          collection.error instanceof ApiError
            ? collection.error.message
            : 'This collection could not be loaded.'
        }
        onRetry={() => void collection.refetch()}
      />
    );
  }

  const data = collection.data!.data;
  const rows = items.data?.data ?? [];

  return (
    <div>
      <Link
        to="/collections"
        className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-[var(--color-ink-400)] hover:text-[var(--color-ink-100)]"
      >
        <ArrowLeft className="size-3.5" /> All collections
      </Link>

      <PageHeader
        title={data.name}
        subtitle={data.description ?? `${data.collectionType.replace(/_/g, ' ')} collection`}
        badge={<Badge tone={statusTone(data.status)}>{data.status}</Badge>}
        action={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<MessageSquarePlus className="size-3.5" />}
              loading={startChat.isPending}
              onClick={() => startChat.mutate()}
            >
              Chat about this collection
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Wand2 className="size-3.5" />}
              onClick={() => setGeneratingReport(true)}
            >
              Generate report
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<MoreHorizontal className="size-4" />}
              onClick={() => setRenaming(true)}
              aria-label="Collection actions"
            >
              Manage
            </Button>
          </>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <Stat label="Items" value={data.itemCount} />
        <Stat label="Analysed" value={data.analyzedCount} />
        <Stat label="Last activity" value={relativeTime(data.lastActivityAt ?? data.updatedAt)} />
        <Stat label="Created" value={formatDateTime(data.createdAt)} />
      </div>

      <Tabs
        className="mb-5"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'items', label: 'All items', count: data.itemCount },
          { value: 'summaries', label: 'Summaries' },
          { value: 'transcripts', label: 'Transcripts' },
          { value: 'insights', label: 'Insights' },
          { value: 'chat', label: 'Chat' },
          { value: 'reports', label: 'Reports' },
          { value: 'activity', label: 'Activity' },
        ]}
      />

      {tab === 'overview' ? (
        <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
          <div>
            <CardHeader title="Recent items" description="Newest items in this collection." />
            {rows.length === 0 ? (
              <EmptyState
                title="No items yet"
                description="This collection is empty. Start a research run against a source, or file items into it from Global Search."
                action={
                  <Button variant="primary" onClick={() => navigate('/reels')}>
                    Start research
                  </Button>
                }
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {rows.slice(0, 6).map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    summary={item.summary}
                    tags={item.tags}
                    onOpen={() => setDetail(item)}
                  />
                ))}
              </div>
            )}
          </div>
          <div>
            <CardHeader title="Jobs" description="Processing history for this collection." />
            <div className="space-y-2.5">
              {(jobs.data?.data ?? []).length === 0 ? (
                <EmptyState
                  title="No jobs"
                  description="Research runs against this collection will appear here."
                />
              ) : (
                (jobs.data?.data ?? []).map((job) => <JobRow key={job.id} job={job} />)
              )}
            </div>
          </div>
        </div>
      ) : null}

      {tab === 'items' || tab === 'summaries' ? (
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Select value={sort} onChange={(event) => setSort(event.target.value)} className="w-44">
              <option value="recent">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="creator">By creator</option>
              <option value="status">By status</option>
            </Select>
            <div className="ml-auto flex gap-1 rounded-[var(--radius-sm)] border border-[var(--color-ink-700)] p-0.5">
              <button
                onClick={() => setView('grid')}
                className={`rounded-[var(--radius-xs)] p-1.5 ${view === 'grid' ? 'bg-[var(--color-ink-750)] text-[var(--color-ink-100)]' : 'text-[var(--color-ink-400)]'}`}
                aria-label="Grid view"
              >
                <LayoutGrid className="size-3.5" />
              </button>
              <button
                onClick={() => setView('list')}
                className={`rounded-[var(--radius-xs)] p-1.5 ${view === 'list' ? 'bg-[var(--color-ink-750)] text-[var(--color-ink-100)]' : 'text-[var(--color-ink-400)]'}`}
                aria-label="List view"
              >
                <List className="size-3.5" />
              </button>
            </div>
          </div>

          {items.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <SkeletonCard key={index} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              title="No items"
              description="Nothing has been discovered for this collection yet."
            />
          ) : view === 'grid' ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rows
                .filter((item) => (tab === 'summaries' ? item.summary : true))
                .map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    summary={item.summary}
                    tags={item.tags}
                    onOpen={() => setDetail(item)}
                  />
                ))}
            </div>
          ) : (
            <div className="surface divide-y divide-[var(--color-ink-700)]">
              {rows
                .filter((item) => (tab === 'summaries' ? item.summary : true))
                .map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setDetail(item)}
                    className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[var(--color-ink-850)]"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[13px] text-[var(--color-ink-100)]">
                        {item.summary?.title ?? item.caption ?? 'Untitled'}
                      </p>
                      <p className="text-[11px] text-[var(--color-ink-500)]">
                        {item.creatorIdentifier ? `@${item.creatorIdentifier}` : 'unknown'} ·{' '}
                        {item.contentType} · {relativeTime(item.publishedAt ?? item.createdAt)}
                      </p>
                    </div>
                    <Badge tone={statusTone(item.processingStatus)}>{item.processingStatus}</Badge>
                  </button>
                ))}
            </div>
          )}
        </div>
      ) : null}

      {tab === 'transcripts' ? (
        <div className="space-y-3">
          {rows.filter((item) => item.summary?.detailedSummary).length === 0 ? (
            <EmptyState
              icon={<FileText className="size-5" />}
              title="No transcripts to show"
              description="Transcripts are stored per item and shown on the item detail panel. They only exist where accessible audio was transcribed."
            />
          ) : (
            rows
              .filter((item) => item.summary)
              .map((item) => (
                <Card key={item.id}>
                  <CardHeader
                    title={item.summary?.title ?? 'Item'}
                    description={`${item.creatorIdentifier ? `@${item.creatorIdentifier}` : 'unknown'} · ${item.contentType}`}
                  />
                  <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--color-ink-300)]">
                    {item.summary?.detailedSummary}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-3 -ml-2"
                    onClick={() => setDetail(item)}
                  >
                    Open full item
                  </Button>
                </Card>
              ))
          )}
        </div>
      ) : null}

      {tab === 'insights' ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows
            .filter((item) => (item.summary?.takeaways.length ?? 0) > 0)
            .map((item) => (
              <Card key={item.id}>
                <CardHeader
                  title={item.summary?.title ?? 'Item'}
                  description="Actionable takeaways"
                />
                <ul className="space-y-1.5">
                  {(item.summary?.takeaways ?? []).map((takeaway) => (
                    <li
                      key={takeaway}
                      className="flex gap-2 text-[12px] leading-relaxed text-[var(--color-ink-300)]"
                    >
                      <span className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--color-accent-500)]" />
                      {takeaway}
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          {rows.every((item) => (item.summary?.takeaways.length ?? 0) === 0) ? (
            <div className="sm:col-span-2 lg:col-span-3">
              <EmptyState
                title="No takeaways yet"
                description="Takeaways appear once items have been summarised."
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === 'chat' ? (
        <EmptyState
          icon={<Bot className="size-6" />}
          title="Chat with this collection"
          description="Ask questions across everything saved here. Answers cite the items they came from, or say the evidence is not present."
          action={
            <Button
              variant="primary"
              loading={startChat.isPending}
              onClick={() => startChat.mutate()}
            >
              Start a conversation
            </Button>
          }
        />
      ) : null}

      {tab === 'reports' ? (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              icon={<Wand2 className="size-3.5" />}
              onClick={() => setGeneratingReport(true)}
            >
              New report
            </Button>
          </div>
          {reports.isLoading ? (
            <SkeletonCard />
          ) : (reports.data?.data ?? []).length === 0 ? (
            <EmptyState
              title="No reports yet"
              description="A report is generated only from summaries already stored here, with every claim linked to its source."
            />
          ) : (
            (reports.data?.data ?? []).map((report) => (
              <Card key={report.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-[var(--color-ink-100)]">{report.title}</p>
                  <p className="text-[11px] text-[var(--color-ink-500)]">
                    {formatDateTime(report.createdAt)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      const { data: full } = await api.reports.get(report.id);
                      setActiveReport({ title: full.title, content: full.content });
                    } catch (error) {
                      errorToast(error);
                    }
                  }}
                >
                  Open
                </Button>
              </Card>
            ))
          )}
        </div>
      ) : null}

      {tab === 'activity' ? (
        <Card>
          <CardHeader
            title="Processing history"
            description="Every job run against this collection."
          />
          <div className="space-y-2.5">
            {(jobs.data?.data ?? []).map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
            {(jobs.data?.data ?? []).length === 0 ? (
              <p className="text-[12px] text-[var(--color-ink-400)]">No activity recorded yet.</p>
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* Item detail */}
      <Dialog
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.summary?.title ?? 'Item detail'}
        description={
          detail
            ? `${detail.creatorIdentifier ? `@${detail.creatorIdentifier}` : 'unknown creator'} · ${detail.contentType}`
            : undefined
        }
        width="max-w-3xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDetail(null)}>
              Close
            </Button>
            {detail ? (
              <a href={detail.sourceUrl} target="_blank" rel="noreferrer noopener">
                <Button variant="secondary">Open source</Button>
              </a>
            ) : null}
          </>
        }
      >
        {detail ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={statusTone(detail.processingStatus)}>{detail.processingStatus}</Badge>
              {detail.sourceProvider === 'demo' ? <Badge tone="warning">DEMO DATA</Badge> : null}
              {detail.tags.map((tag) => (
                <Badge key={tag.id} tone="neutral">
                  {tag.normalizedName}
                </Badge>
              ))}
            </div>

            {detail.caption ? (
              <section>
                <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-500)]">
                  Caption (source text)
                </h4>
                <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--color-ink-300)]">
                  {detail.caption}
                </p>
              </section>
            ) : null}

            {detail.summary ? (
              <>
                <section>
                  <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-500)]">
                    AI summary
                  </h4>
                  <p className="text-[12px] leading-relaxed text-[var(--color-ink-200)]">
                    {detail.summary.detailedSummary ?? detail.summary.shortSummary}
                  </p>
                </section>
                {detail.summary.mainPoints.length > 0 ? (
                  <section>
                    <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-500)]">
                      Main points
                    </h4>
                    <ul className="space-y-1">
                      {detail.summary.mainPoints.map((point) => (
                        <li
                          key={point}
                          className="flex gap-2 text-[12px] leading-relaxed text-[var(--color-ink-300)]"
                        >
                          <span className="mt-1.5 size-1 shrink-0 rounded-full bg-[var(--color-ink-500)]" />
                          {point}
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {detail.summary.visualAnalysis ? (
                  <section>
                    <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-500)]">
                      Visual analysis
                    </h4>
                    <div className="grid gap-1.5 text-[12px] sm:grid-cols-2">
                      <Kv label="Layout" value={detail.summary.visualAnalysis.layoutType} />
                      <Kv label="Hierarchy" value={detail.summary.visualAnalysis.visualHierarchy} />
                      <Kv label="Composition" value={detail.summary.visualAnalysis.composition} />
                      <Kv label="CTA" value={detail.summary.visualAnalysis.callToActionPlacement} />
                      <Kv label="Category" value={detail.summary.visualAnalysis.designCategory} />
                      <Kv
                        label="Observed text"
                        value={detail.summary.visualAnalysis.observedText}
                      />
                    </div>
                    {detail.summary.visualAnalysis.interpretation ? (
                      <p className="mt-2 rounded-[var(--radius-xs)] border border-[var(--color-ink-700)] bg-[var(--color-ink-850)] p-2 text-[11px] leading-relaxed text-[var(--color-ink-400)]">
                        <strong className="text-[var(--color-ink-300)]">
                          Interpretation (not observed):
                        </strong>{' '}
                        {detail.summary.visualAnalysis.interpretation}
                      </p>
                    ) : null}
                  </section>
                ) : null}
                <p className="text-[11px] text-[var(--color-ink-500)]">
                  Generated by {detail.summary.modelIdentifier ?? 'unknown model'}
                </p>
              </>
            ) : (
              <p className="text-[12px] text-[var(--color-ink-400)]">
                No summary has been generated for this item yet.
              </p>
            )}
          </div>
        ) : null}
      </Dialog>

      {/* Manage */}
      <Dialog
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Manage collection"
        description="Rename, archive, duplicate or delete this collection."
        footer={
          <Button variant="ghost" onClick={() => setRenaming(false)}>
            Done
          </Button>
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="rename">Name</Label>
            <div className="flex gap-2">
              <Input
                id="rename"
                value={newName || data.name}
                onChange={(event) => setNewName(event.target.value)}
              />
              <Button
                variant="secondary"
                loading={rename.isPending}
                onClick={() => rename.mutate()}
              >
                Save
              </Button>
            </div>
          </div>
          <div className="grid gap-2">
            <Button
              variant="secondary"
              icon={<Copy className="size-3.5" />}
              loading={duplicate.isPending}
              onClick={() => duplicate.mutate()}
            >
              Duplicate collection
            </Button>
            <Button
              variant="secondary"
              loading={archive.isPending}
              onClick={() => archive.mutate(data.status === 'archived' ? 'active' : 'archived')}
            >
              {data.status === 'archived' ? 'Restore from archive' : 'Archive collection'}
            </Button>
            <Button
              variant="danger"
              icon={<Trash2 className="size-3.5" />}
              loading={remove.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `Delete "${data.name}" and all of its items? This cannot be undone.`,
                  )
                ) {
                  remove.mutate();
                }
              }}
            >
              Delete collection
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Report generation */}
      <Dialog
        open={generatingReport}
        onClose={() => setGeneratingReport(false)}
        title="Generate research report"
        description="Built only from summaries already stored in this collection. Every finding links to its source."
        footer={
          <>
            <Button variant="ghost" onClick={() => setGeneratingReport(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={createReport.isPending}
              onClick={() => createReport.mutate()}
            >
              Generate
            </Button>
          </>
        }
      >
        <div>
          <Label htmlFor="report-question" hint="optional">
            Research question
          </Label>
          <Textarea
            id="report-question"
            value={reportQuestion}
            onChange={(event) => setReportQuestion(event.target.value)}
            placeholder="e.g. What layout patterns recur across these references?"
          />
        </div>
      </Dialog>

      {/* Report view */}
      <Dialog
        open={Boolean(activeReport)}
        onClose={() => setActiveReport(null)}
        title={activeReport?.title ?? 'Report'}
        width="max-w-3xl"
        footer={
          <Button
            variant="secondary"
            onClick={() => {
              if (!activeReport) return;
              void navigator.clipboard.writeText(activeReport.content);
              push({ tone: 'success', title: 'Report copied as Markdown' });
            }}
          >
            Copy as Markdown
          </Button>
        }
      >
        <div className="prose-report whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--color-ink-200)]">
          {activeReport?.content}
        </div>
      </Dialog>

      <p className="mt-8 text-center text-[11px] text-[var(--color-ink-500)]">
        {pluralise(data.itemCount, 'item')} in this collection
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="surface p-3">
      <p className="text-[10px] uppercase tracking-wide text-[var(--color-ink-500)]">{label}</p>
      <p className="mt-0.5 truncate text-[13px] text-[var(--color-ink-100)]">{value}</p>
    </div>
  );
}

function Kv({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <span className="text-[var(--color-ink-500)]">{label}: </span>
      <span className="text-[var(--color-ink-200)]">{value}</span>
    </div>
  );
}

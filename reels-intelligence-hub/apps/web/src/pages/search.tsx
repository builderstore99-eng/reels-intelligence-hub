import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Info, Search as SearchIcon, SlidersHorizontal } from 'lucide-react';
import { api, type SearchHit } from '../lib/api';
import { PageHeader } from '../components/layout';
import { ItemCard } from '../components/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Label,
  Select,
  SkeletonCard,
  Tabs,
} from '../components/ui';
import { pluralise } from '../lib/utils';

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [term, setTerm] = useState(params.get('q') ?? '');
  const [mode, setMode] = useState<'hybrid' | 'lexical' | 'semantic'>('hybrid');
  const [sort, setSort] = useState('relevance');
  const [contentType, setContentType] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const query = params.get('q') ?? '';

  // Keep the input in sync when the URL changes (e.g. from the top bar).
  useEffect(() => {
    setTerm(params.get('q') ?? '');
  }, [params]);

  const results = useQuery({
    queryKey: ['search', query, mode, sort, contentType],
    queryFn: () =>
      api.search.query({
        q: query,
        mode,
        sort,
        pageSize: 48,
        ...(contentType ? { contentType } : {}),
      }),
    enabled: query.trim().length > 0,
  });

  const meta = results.data?.meta as
    { semanticAvailable?: boolean; notice?: string | null; indexedItems?: number } | undefined;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next = term.trim();
    if (next) setParams({ q: next });
    else setParams({});
  }

  const hits: SearchHit[] = results.data?.data ?? [];

  return (
    <div>
      <PageHeader
        title="Global Search"
        subtitle="Search every collection you own. Keyword and semantic results are fused and ranked, then de-duplicated."
      />

      <form onSubmit={submit} className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-64 flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--color-ink-500)]" />
          <Input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Find all saved references to minimal SaaS dashboards…"
            className="h-10 pl-9"
            aria-label="Search query"
          />
        </div>
        <Button type="submit" variant="primary" className="h-10">
          Search
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="h-10"
          icon={<SlidersHorizontal className="size-4" />}
          onClick={() => setShowFilters((open) => !open)}
        >
          Filters
        </Button>
      </form>

      {showFilters ? (
        <Card className="mb-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="mode">Mode</Label>
              <Select
                id="mode"
                value={mode}
                onChange={(event) => setMode(event.target.value as typeof mode)}
              >
                <option value="hybrid">Hybrid (keyword + semantic)</option>
                <option value="lexical">Keyword only</option>
                <option value="semantic">Semantic only</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="sort">Sort</Label>
              <Select id="sort" value={sort} onChange={(event) => setSort(event.target.value)}>
                <option value="relevance">Relevance</option>
                <option value="recent">Newest first</option>
                <option value="oldest">Oldest first</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="ctype">Content type</Label>
              <Select
                id="ctype"
                value={contentType}
                onChange={(event) => setContentType(event.target.value)}
              >
                <option value="">Any</option>
                <option value="reel">Reel</option>
                <option value="video">Video</option>
                <option value="image">Image</option>
                <option value="carousel">Carousel</option>
                <option value="document">Document</option>
              </Select>
            </div>
          </div>
        </Card>
      ) : null}

      {meta?.notice ? (
        <div className="mb-4 flex items-start gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-info-500)]/30 bg-[var(--color-info-500)]/8 p-3">
          <Info className="mt-0.5 size-3.5 shrink-0 text-[var(--color-info-500)]" />
          <p className="text-[12px] leading-relaxed text-[var(--color-ink-200)]">{meta.notice}</p>
        </div>
      ) : null}

      {query.trim().length === 0 ? (
        <EmptyState
          icon={<SearchIcon className="size-6" />}
          title="Search your research library"
          description="Every caption, summary, transcript and tag you have saved is searchable. Try a phrase, a creator, or a concept."
        />
      ) : results.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <SkeletonCard key={index} />
          ))}
        </div>
      ) : results.isError ? (
        <ErrorState message="Search failed." onRetry={() => void results.refetch()} />
      ) : hits.length === 0 ? (
        <EmptyState
          title="No matches"
          description={`Nothing in your ${meta?.indexedItems ?? 0} saved items matches “${query}”. Try a broader term, or save more research first.`}
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-ink-400)]">
            <span>{pluralise(hits.length, 'result')}</span>
            <span>·</span>
            <Badge tone={meta?.semanticAvailable ? 'success' : 'neutral'}>
              {meta?.semanticAvailable ? 'semantic index active' : 'keyword only'}
            </Badge>
            <span>·</span>
            <span>{mode} mode</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {hits.map((hit) => (
              <ItemCard
                key={hit.id}
                item={hit}
                summary={
                  hit.excerpt
                    ? {
                        id: hit.id,
                        contentItemId: hit.id,
                        summaryType: 'standard',
                        title: null,
                        shortSummary: hit.excerpt,
                        detailedSummary: null,
                        mainPoints: [],
                        takeaways: [],
                        visualAnalysis: null,
                        sourceReferences: [],
                        modelIdentifier: null,
                        createdAt: '',
                      }
                    : null
                }
                tags={hit.tags.map((tag) => ({ normalizedName: tag }))}
              />
            ))}
          </div>
        </>
      )}

      <div className="mt-6">
        <Tabs
          tabs={[{ value: 'relevance', label: `Relevance scores` }]}
          value="relevance"
          onChange={() => undefined}
        />
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink-500)]">
          Ranking: lexical (bm25) and semantic (cosine) scores are min-max normalised per query,
          fused 0.45 / 0.55, with a small reciprocal-rank term to favour items that score well in
          both. See ARCHITECTURE.md § Search.
        </p>
      </div>
    </div>
  );
}

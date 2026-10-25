import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Plus, Search } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useErrorToast, useToast } from '../lib/app-context';
import { PageHeader } from '../components/layout';
import { CollectionCard } from '../components/shared';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  FieldError,
  Input,
  Label,
  Select,
  SkeletonCard,
  Textarea,
} from '../components/ui';

export default function CollectionsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const errorToast = useErrorToast();
  const { push } = useToast();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('custom');
  const [formError, setFormError] = useState<string | null>(null);

  const collections = useQuery({
    queryKey: ['collections', { search, status }],
    queryFn: () => api.collections.list({ search, status, pageSize: 60 }),
  });

  const create = useMutation({
    mutationFn: () =>
      api.collections.create({
        name: name.trim(),
        description: description.trim() || undefined,
        collectionType: type,
      }),
    onSuccess: ({ data }) => {
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      push({ tone: 'success', title: 'Collection created' });
      setCreating(false);
      setName('');
      setDescription('');
      navigate(`/collections/${data.id}`);
    },
    onError: (error) => {
      if (error instanceof ApiError && Object.keys(error.fields).length > 0) {
        setFormError(Object.values(error.fields)[0] ?? error.message);
        return;
      }
      errorToast(error);
    },
  });

  const rows = collections.data?.data ?? [];

  return (
    <div>
      <PageHeader
        title="My Collections"
        subtitle="Every research project is a collection with its own library, search and AI chat."
        action={
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => setCreating(true)}
          >
            New collection
          </Button>
        }
      />

      <div className="mb-5 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-ink-500)]" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter by name or description…"
            className="pl-8.5"
            aria-label="Filter collections"
          />
        </div>
        <Select value={status} onChange={(event) => setStatus(event.target.value)} className="w-40">
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="processing">Processing</option>
          <option value="paused">Paused</option>
          <option value="archived">Archived</option>
        </Select>
      </div>

      {collections.isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <SkeletonCard key={index} />
          ))}
        </div>
      ) : collections.isError ? (
        <ErrorState
          message="Collections could not be loaded."
          onRetry={() => void collections.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="size-6" />}
          title={search ? 'No collections match that filter' : 'No collections yet'}
          description={
            search
              ? 'Try a different term, or clear the filter.'
              : 'Start a research run, or create an empty collection to file items into later.'
          }
          action={
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => navigate('/reels')}>
                Start research
              </Button>
              <Button variant="secondary" onClick={() => setCreating(true)}>
                Create empty
              </Button>
            </div>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((collection) => (
            <CollectionCard key={collection.id} collection={collection} />
          ))}
        </div>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="New collection"
        description="An empty collection you can file items into, or use as a chat scope."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={name.trim().length === 0}
              onClick={() => {
                setFormError(null);
                create.mutate();
              }}
            >
              Create collection
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="c-name">Name</Label>
            <Input
              id="c-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Landing page teardowns"
            />
            <FieldError>{formError}</FieldError>
          </div>
          <div>
            <Label htmlFor="c-desc" hint="optional">
              Description
            </Label>
            <Textarea
              id="c-desc"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What is this research for?"
            />
          </div>
          <div>
            <Label htmlFor="c-type">Type</Label>
            <Select id="c-type" value={type} onChange={(event) => setType(event.target.value)}>
              <option value="custom">Custom</option>
              <option value="manual">Manual</option>
              <option value="design_references">Design references</option>
              <option value="document_library">Document library</option>
              <option value="topic_research">Topic research</option>
              <option value="instagram_profile">Instagram profile</option>
            </Select>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

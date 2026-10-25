import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Copy, ExternalLink, MessageSquarePlus, Send, Trash2, User } from 'lucide-react';
import type { ChatMessage } from '@rih/shared';
import { api, ApiError } from '../lib/api';
import { useErrorToast, useToast } from '../lib/app-context';
import { PageHeader } from '../components/layout';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  Label,
  Select,
  Skeleton,
  Spinner,
} from '../components/ui';
import { cn, relativeTime } from '../lib/utils';

/**
 * AI research chat.
 *
 * Scope is chosen explicitly: one collection, several collections, or the whole
 * knowledge base. The server enforces the scope in SQL, so a narrower selection
 * can never leak wider results.
 */
export default function ChatPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const errorToast = useErrorToast();
  const { push } = useToast();

  const conversationId = params.get('conversation');
  const [draft, setDraft] = useState('');
  const [scope, setScope] = useState<'knowledge_base' | 'collection'>('knowledge_base');
  const [scopeCollection, setScopeCollection] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const conversations = useQuery({
    queryKey: ['conversations'],
    queryFn: () => api.chat.conversations(),
  });

  const collections = useQuery({
    queryKey: ['collections', 'chat-scope'],
    queryFn: () => api.collections.list({ pageSize: 100 }),
  });

  const active = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => api.chat.get(conversationId!),
    enabled: Boolean(conversationId),
  });

  const messages = active.data?.data.messages ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  const createConversation = useMutation({
    mutationFn: () =>
      api.chat.create({
        scopeType: scope,
        collectionId: scope === 'collection' ? scopeCollection || null : null,
        title: 'New conversation',
      }),
    onSuccess: ({ data }) => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      setParams({ conversation: data.id });
    },
    onError: (error) => errorToast(error),
  });

  const send = useMutation({
    mutationFn: (content: string) => api.chat.send(conversationId!, { content }),
    onSuccess: () => {
      setDraft('');
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['usage'] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'PROVIDER_NOT_CONFIGURED') {
        push({
          tone: 'warning',
          title: 'No AI key configured',
          description: 'Add a provider key in Settings → API Keys, then ask again.',
        });
        return;
      }
      errorToast(error);
    },
  });

  const removeConversation = useMutation({
    mutationFn: (id: string) => api.chat.remove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      setParams({});
    },
    onError: (error) => errorToast(error),
  });

  const collectionOptions = useMemo(() => collections.data?.data ?? [], [collections.data]);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    if (!conversationId) {
      createConversation.mutate();
      return;
    }
    send.mutate(content);
  }

  return (
    <div>
      <PageHeader
        title="AI Research Chat"
        subtitle="Ask questions about your saved research. Answers cite the items they came from — or state that the evidence is not there."
        action={
          <Button
            variant="primary"
            icon={<MessageSquarePlus className="size-4" />}
            loading={createConversation.isPending}
            onClick={() => createConversation.mutate()}
          >
            New conversation
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <aside className="space-y-3">
          <Card className="p-3">
            <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-500)]">
              Scope for new conversations
            </p>
            <Select
              value={scope}
              onChange={(event) => setScope(event.target.value as typeof scope)}
              className="mb-2"
            >
              <option value="knowledge_base">Entire knowledge base</option>
              <option value="collection">One collection</option>
            </Select>
            {scope === 'collection' ? (
              <Select
                value={scopeCollection}
                onChange={(event) => setScopeCollection(event.target.value)}
              >
                <option value="">Choose a collection…</option>
                {collectionOptions.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.name}
                  </option>
                ))}
              </Select>
            ) : null}
          </Card>

          <div className="surface p-1.5">
            <p className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-500)]">
              Conversations
            </p>
            {conversations.isLoading ? (
              <div className="space-y-1 p-1">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : (conversations.data?.data ?? []).length === 0 ? (
              <p className="px-2 py-3 text-[12px] text-[var(--color-ink-400)]">None yet.</p>
            ) : (
              (conversations.data?.data ?? []).map((conversation) => (
                <div
                  key={conversation.id}
                  className={cn(
                    'group flex items-center gap-1 rounded-[var(--radius-xs)] px-2 py-1.5',
                    conversationId === conversation.id
                      ? 'bg-[var(--color-ink-800)]'
                      : 'hover:bg-[var(--color-ink-850)]',
                  )}
                >
                  <button
                    onClick={() => setParams({ conversation: conversation.id })}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="truncate text-[12px] text-[var(--color-ink-100)]">
                      {conversation.title}
                    </p>
                    <p className="truncate text-[10px] text-[var(--color-ink-500)]">
                      {conversation.messageCount} · {relativeTime(conversation.updatedAt)}
                    </p>
                  </button>
                  <button
                    onClick={() => removeConversation.mutate(conversation.id)}
                    aria-label="Delete conversation"
                    className="opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <Trash2 className="size-3 text-[var(--color-ink-500)] hover:text-[var(--color-danger-500)]" />
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>

        <section className="surface flex h-[calc(100vh-13rem)] min-h-96 flex-col">
          {!conversationId ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                icon={<Bot className="size-6" />}
                title="Start a conversation"
                description="Pick a scope, then ask a question. Retrieval runs over the collections in that scope only, and every answer carries citations."
                action={
                  <Button
                    variant="primary"
                    loading={createConversation.isPending}
                    onClick={() => createConversation.mutate()}
                  >
                    New conversation
                  </Button>
                }
              />
            </div>
          ) : active.isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner className="size-5" />
            </div>
          ) : active.isError ? (
            <div className="p-4">
              <ErrorState
                message="That conversation could not be loaded."
                onRetry={() => void active.refetch()}
              />
            </div>
          ) : (
            <>
              <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
                {messages.length === 0 ? (
                  <div className="mx-auto max-w-md py-10 text-center">
                    <p className="text-[13px] text-[var(--color-ink-300)]">Ask something like:</p>
                    <ul className="mt-3 space-y-1.5 text-[12px] text-[var(--color-ink-400)]">
                      {[
                        'What are the five most common design patterns in this collection?',
                        'Summarise everything about lead generation.',
                        'Which sources support this recommendation?',
                        'What recurring mistakes do these videos identify?',
                      ].map((example) => (
                        <li key={example}>
                          <button
                            className="hover:text-[var(--color-accent-400)]"
                            onClick={() => setDraft(example)}
                          >
                            “{example}”
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  messages.map((message) => <MessageBubble key={message.id} message={message} />)
                )}
                {send.isPending ? (
                  <div className="flex items-center gap-2 px-1 text-[12px] text-[var(--color-ink-400)]">
                    <Spinner className="size-3.5" /> Retrieving sources and generating an answer…
                  </div>
                ) : null}
              </div>

              <form onSubmit={submit} className="border-t border-[var(--color-ink-700)] p-3">
                <div className="flex items-end gap-2">
                  <Input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="Ask about your research…"
                    aria-label="Message"
                    disabled={send.isPending}
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={!draft.trim() || send.isPending}
                    icon={<Send className="size-3.5" />}
                  >
                    Send
                  </Button>
                </div>
                <p className="mt-1.5 text-[10px] text-[var(--color-ink-500)]">
                  Answers are generated from retrieved items only. If the evidence is missing, the
                  assistant will say so.
                </p>
              </form>
            </>
          )}
        </section>
      </div>

      <div className="mt-6">
        <Label>Scope note</Label>
        <p className="text-[11px] leading-relaxed text-[var(--color-ink-500)]">
          Scope is enforced server-side: retrieval queries always filter on your user id and on the
          selected collection(s). Cross-user retrieval is impossible by construction, not by
          convention.
        </p>
      </div>

      <div className="mt-4">
        <Button variant="ghost" size="sm" onClick={() => navigate('/collections')}>
          Browse collections
        </Button>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const { push } = useToast();
  const isUser = message.role === 'user';

  return (
    <div className={cn('flex gap-2.5', isUser ? 'justify-end' : 'justify-start')}>
      {!isUser ? (
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-[var(--color-accent-500)]/15 text-[var(--color-accent-400)]">
          <Bot className="size-3.5" />
        </span>
      ) : null}

      <div className={cn('max-w-[85%] space-y-2', isUser && 'items-end text-right')}>
        <div
          className={cn(
            'rounded-[var(--radius-md)] px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap',
            isUser
              ? 'bg-[var(--color-accent-500)] text-white'
              : 'bg-[var(--color-ink-850)] text-[var(--color-ink-200)]',
          )}
        >
          {message.content}
        </div>

        {message.citations.length > 0 ? (
          <div className="space-y-1 rounded-[var(--radius-sm)] border border-[var(--color-ink-700)] p-2 text-left">
            <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-ink-500)]">
              Sources
            </p>
            {message.citations.map((citation) => (
              <a
                key={`${citation.contentItemId}-${citation.label}`}
                href={citation.url}
                target="_blank"
                rel="noreferrer noopener"
                className="block rounded-[var(--radius-xs)] px-1.5 py-1 hover:bg-[var(--color-ink-800)]"
              >
                <span className="flex items-center gap-1 text-[11px] text-[var(--color-accent-400)]">
                  {citation.label} <ExternalLink className="size-2.5" />
                </span>
                {citation.excerpt ? (
                  <span className="mt-0.5 line-clamp-2 block text-[10px] leading-relaxed text-[var(--color-ink-500)]">
                    {citation.excerpt}
                  </span>
                ) : null}
              </a>
            ))}
          </div>
        ) : null}

        {!isUser ? (
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                void navigator.clipboard.writeText(message.content);
                push({ tone: 'success', title: 'Answer copied' });
              }}
              className="inline-flex items-center gap-1 text-[10px] text-[var(--color-ink-500)] hover:text-[var(--color-ink-200)]"
            >
              <Copy className="size-2.5" /> Copy
            </button>
            {message.modelIdentifier ? (
              <Badge tone="neutral">{message.modelIdentifier}</Badge>
            ) : null}
            {message.citations.length === 0 ? <Badge tone="warning">no citations</Badge> : null}
          </div>
        ) : null}
      </div>

      {isUser ? (
        <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-[var(--color-ink-800)] text-[var(--color-ink-300)]">
          <User className="size-3.5" />
        </span>
      ) : null}
    </div>
  );
}

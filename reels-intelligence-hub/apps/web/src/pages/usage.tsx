import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatUsd } from '@rih/shared';
import { api } from '../lib/api';
import { PageHeader } from '../components/layout';
import { MetricCard } from '../components/shared';
import { Badge, Card, CardHeader, EmptyState, ErrorState, SkeletonCard } from '../components/ui';
import { formatDateTime } from '../lib/utils';

const PIE_COLOURS = ['#3d8bf0', '#46b17b', '#e09a45', '#8b95a8', '#e06464', '#5aa9e6'];

export default function UsagePage() {
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => api.usage() });

  if (usage.isLoading) return <SkeletonCard />;
  if (usage.isError) {
    return <ErrorState message="Usage data could not load." onRetry={() => void usage.refetch()} />;
  }

  const { summary, events } = usage.data!.data;

  return (
    <div>
      <PageHeader
        title="Usage & Costs"
        subtitle="Every AI call is metered with its token counts and an estimated cost. Estimates use published per-unit prices and are not a billing statement."
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Estimated spend"
          value={formatUsd(summary.totalCostUsd)}
          hint="All time"
        />
        <MetricCard label="AI calls" value={summary.totalCalls} hint="Metered operations" />
        <MetricCard
          label="Input tokens"
          value={summary.totalInputTokens.toLocaleString('en-IN')}
          hint="Prompt side"
        />
        <MetricCard
          label="Output tokens"
          value={summary.totalOutputTokens.toLocaleString('en-IN')}
          hint="Completion side"
        />
      </div>

      {summary.totalCalls === 0 ? (
        <EmptyState
          title="No usage yet"
          description="Metering starts with the first summarisation, embedding, transcription or chat call. Add a provider key in Settings → API Keys to enable AI features."
        />
      ) : (
        <>
          <div className="mb-6 grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader title="Daily spend" description="Last 30 days, estimated." />
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={summary.byDay}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 10, fill: '#8b95a8' }}
                      tickFormatter={(value: string) => value.slice(5)}
                    />
                    <YAxis tick={{ fontSize: 10, fill: '#8b95a8' }} width={44} />
                    <Tooltip
                      contentStyle={{
                        background: '#12151c',
                        border: '1px solid #2a3140',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      formatter={(value: number) => [formatUsd(value), 'Cost']}
                    />
                    <Bar dataKey="costUsd" fill="#3d8bf0" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card>
              <CardHeader title="Spend by provider" />
              <div className="flex items-center gap-4">
                <div className="h-44 w-1/2">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={summary.byProvider}
                        dataKey="costUsd"
                        nameKey="provider"
                        innerRadius={40}
                        outerRadius={70}
                        paddingAngle={2}
                      >
                        {summary.byProvider.map((entry, index) => (
                          <Cell
                            key={entry.provider}
                            fill={PIE_COLOURS[index % PIE_COLOURS.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          background: '#12151c',
                          border: '1px solid #2a3140',
                          borderRadius: 8,
                          fontSize: 12,
                        }}
                        formatter={(value: number) => [formatUsd(value), 'Cost']}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="flex-1 space-y-1.5">
                  {summary.byProvider.map((entry, index) => (
                    <li
                      key={entry.provider}
                      className="flex items-center justify-between text-[12px]"
                    >
                      <span className="flex items-center gap-1.5 text-[var(--color-ink-300)]">
                        <span
                          className="size-2 rounded-full"
                          style={{ background: PIE_COLOURS[index % PIE_COLOURS.length] }}
                        />
                        {entry.provider}
                      </span>
                      <span className="tabular-nums text-[var(--color-ink-200)]">
                        {formatUsd(entry.costUsd)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          </div>

          <Card className="mb-6">
            <CardHeader title="By operation" />
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {summary.byOperation.map((entry) => (
                <div
                  key={entry.operation}
                  className="rounded-[var(--radius-sm)] bg-[var(--color-ink-850)] p-3"
                >
                  <p className="text-[11px] uppercase tracking-wide text-[var(--color-ink-500)]">
                    {entry.operation}
                  </p>
                  <p className="mt-0.5 text-[15px] font-semibold tabular-nums text-[var(--color-ink-100)]">
                    {formatUsd(entry.costUsd)}
                  </p>
                  <p className="text-[11px] text-[var(--color-ink-400)]">{entry.calls} calls</p>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Recent metered calls" description="Newest first." />
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12px]">
                <thead>
                  <tr className="border-b border-[var(--color-ink-700)] text-[10px] uppercase tracking-wide text-[var(--color-ink-500)]">
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">Provider</th>
                    <th className="py-2 pr-3 font-medium">Model</th>
                    <th className="py-2 pr-3 font-medium">Operation</th>
                    <th className="py-2 pr-3 text-right font-medium">Tokens</th>
                    <th className="py-2 text-right font-medium">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {events.slice(0, 40).map((event) => (
                    <tr key={event.id} className="border-b border-[var(--color-ink-800)]">
                      <td className="py-2 pr-3 text-[var(--color-ink-400)]">
                        {formatDateTime(event.createdAt)}
                      </td>
                      <td className="py-2 pr-3 text-[var(--color-ink-200)]">{event.provider}</td>
                      <td className="py-2 pr-3 text-[var(--color-ink-300)]">
                        {event.modelIdentifier}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge tone="neutral">{event.operationType}</Badge>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-[var(--color-ink-400)]">
                        {event.inputUnits}/{event.outputUnits}
                      </td>
                      <td className="py-2 text-right tabular-nums text-[var(--color-ink-200)]">
                        {formatUsd(event.estimatedCost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

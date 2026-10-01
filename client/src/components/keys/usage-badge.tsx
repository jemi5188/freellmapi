import { AlertTriangle } from 'lucide-react'
import type { ApiKey } from '../../../../shared/types'
import { Tooltip } from '@/components/tooltip'
import { useI18n } from '@/i18n'

type Usage = NonNullable<ApiKey['usage']>

const ratioTone = (ratio: number) =>
  ratio <= 0.2
    ? { text: 'text-red-600 dark:text-red-400', bar: 'bg-red-500' }
    : ratio <= 0.5
      ? { text: 'text-amber-600 dark:text-amber-400', bar: 'bg-amber-500' }
      : { text: 'text-emerald-600 dark:text-emerald-400', bar: 'bg-emerald-500' }

/** Per-key allowance badge (puter keys only; spec §4.2). Display-only —
 *  routing behavior never changes based on it. */
export function UsageBadge({ usage, fetchFailed }: { usage: Usage; fetchFailed: boolean }) {
  const { t } = useI18n()
  const ratio = usage.allowance > 0 ? usage.remaining / usage.allowance : 0
  const tone = ratioTone(ratio)
  // One decimal everywhere: 972.06 credits must not collapse into a bare 972.
  const remaining = Math.round(usage.remaining * 10) / 10
  return (
    <Tooltip
      text={
        fetchFailed
          ? t('keys.usageStale')
          : t('keys.usageUpdated', { time: new Date(usage.updatedAt).toLocaleString() })
      }
    >
      <span
        data-testid="usage-badge"
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-mono tabular-nums ${tone.text}`}
        title={t('keys.usageBadge')}
      >
        {fetchFailed && <AlertTriangle data-testid="usage-fetch-warning" className="size-3" />}
        <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
          <span className={`block h-full ${tone.bar}`} style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} />
        </span>
        <span>
          {remaining} / {usage.allowance} {usage.unit}
        </span>
      </span>
    </Tooltip>
  )
}

import { useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { diffOps, parseDraft, resetOps, resolveSection, toDraft, type Draft, type DraftErrors } from './draft.js'
import { zh } from './locales.js'

export interface SettingsProps {
  form: ConfigForm<unknown>
  t?: (key: string) => string
  view?: 'summary' | 'page'
}

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed' }

/** Edits stay local until Save; every write carries the revision it was read at. */
export function AutoRetrySettings(props: SettingsProps) {
  const t = props.t ?? ((key: string) => zh[key] ?? key)
  const snapshot = useSyncExternalStore(props.form.subscribe.bind(props.form), () => props.form.getSnapshot())
  const current = useMemo(() => resolveSection(snapshot.value), [snapshot.value])
  const accepted = useMemo(() => toDraft(current), [current])
  const [draft, setDraft] = useState<Draft>(accepted)
  const [dirty, setDirty] = useState(false)
  const [errors, setErrors] = useState<DraftErrors>({})
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const id = useId()

  // Follow Host changes (another window, a reset) until the user starts editing.
  useEffect(() => { if (!dirty) setDraft(accepted) }, [accepted, dirty])

  if (props.view === 'summary') return <>{t('intro')}</>
  if (snapshot.status === 'loading') return <div className="dar-settings"><p className="dar-hint">{t('loading')}</p></div>
  if (snapshot.status === 'unavailable') return <div className="dar-settings"><p className="dar-hint">{t('unavailable')}</p></div>

  const disabled = !snapshot.writable || status.kind === 'saving'
  const user = (snapshot.user && typeof snapshot.user === 'object' ? snapshot.user : {}) as Record<string, unknown>
  const edit = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft(previous => ({ ...previous, [key]: value }))
    setDirty(true)
    setErrors(previous => ({ ...previous, [key]: undefined }))
    if (status.kind !== 'saving') setStatus({ kind: 'idle' })
  }
  const write = async (ops: ReturnType<typeof diffOps>) => {
    if (ops.length === 0) { setDirty(false); return }
    setStatus({ kind: 'saving' })
    try {
      const ok = await props.form.mutate(ops, snapshot.revision)
      setStatus({ kind: ok ? 'saved' : 'failed' })
      if (ok) setDirty(false)
    } catch {
      setStatus({ kind: 'failed' })
    }
  }
  const save = () => {
    const parsed = parseDraft(draft, current)
    if (parsed.errors) { setErrors(parsed.errors); return }
    void write(diffOps(current, parsed.settings))
  }
  const reset = () => {
    if (!window.confirm(t('resetConfirm'))) return
    setErrors({})
    void write(resetOps(snapshot.user))
  }
  const error = (key: keyof Draft) => {
    const entry = errors[key]
    return entry ? <small className="dar-error" role="alert">{t(entry.key)}{entry.detail ?? ''}</small> : null
  }
  const changed = (...fields: string[]) => fields.some(field => field in user)
    ? <span className="dar-badge">{t('overridden')}</span> : null
  const field = (key: keyof Draft, label: string, input: ReactNode, hint?: string, overrideFields: string[] = []) => (
    <div className="dar-field">
      <label htmlFor={`${id}-${key}`}>{label}{changed(...overrideFields)}</label>
      {input}
      {hint ? <small>{hint}</small> : null}
      {error(key)}
    </div>
  )
  const text = (key: keyof Draft, inputMode?: 'numeric' | 'decimal') => (
    <input id={`${id}-${key}`} type="text" inputMode={inputMode} value={draft[key] as string} disabled={disabled}
      aria-invalid={errors[key] ? true : undefined} onChange={event => edit(key, event.target.value as never)} />
  )
  const area = (key: keyof Draft, rows: number) => (
    <textarea id={`${id}-${key}`} rows={rows} spellCheck={false} value={draft[key] as string} disabled={disabled}
      aria-invalid={errors[key] ? true : undefined} onChange={event => edit(key, event.target.value as never)} />
  )
  const toggle = (key: 'enabled' | 'respectRetryAfter', label: string, hint: string) => (
    <label className="dar-toggle">
      <input type="checkbox" checked={draft[key]} disabled={disabled} onChange={event => edit(key, event.target.checked)} />
      <span><span>{label}{changed(key)}</span><small>{hint}</small></span>
    </label>
  )

  return (
    <div className="dar-settings">
      <p>{t('intro')}</p>
      {!snapshot.writable ? <p className="dar-hint">{t('readOnly')}</p> : null}
      {toggle('enabled', t('enabled'), t('enabledHint'))}
      <div className="dar-grid">
        {field('maxRetries', t('maxRetries'), text('maxRetries', 'numeric'), t('maxRetriesHint'), ['maxRetries'])}
        {field('initialDelay', t('initialDelay'), text('initialDelay', 'decimal'), t('initialDelayHint'), ['initialDelayMs'])}
        {field('maxDelay', t('maxDelay'), text('maxDelay', 'decimal'), undefined, ['maxDelayMs'])}
      </div>
      {toggle('respectRetryAfter', t('respectRetryAfter'), t('respectRetryAfterHint'))}
      <fieldset>
        <legend>{t('rules')}</legend>
        <p className="dar-hint">{t('rulesHint')}</p>
        {field('statusCodes', t('statusCodes'), area('statusCodes', 2), t('statusCodesHint'), ['statusCodes'])}
        {field('codes', t('codes'), area('codes', 2), t('codesHint'), ['codes'])}
        {field('messagePatterns', t('patterns'), area('messagePatterns', 5), t('patternsHint'), ['messagePatterns'])}
        {field('excludeCodes', t('excludeCodes'), area('excludeCodes', 3), t('excludeCodesHint'), ['excludeCodes'])}
        {field('providers', t('providers'), text('providers'), t('providersHint'), ['providers'])}
      </fieldset>
      <div className="dar-actions">
        <button type="button" data-action="save" disabled={disabled || !dirty} onClick={save}>
          {status.kind === 'saving' ? t('saving') : t('save')}
        </button>
        <button type="button" disabled={disabled || !dirty} onClick={() => { setDraft(accepted); setDirty(false); setErrors({}); setStatus({ kind: 'idle' }) }}>
          {t('discard')}
        </button>
        <button type="button" disabled={disabled || Object.keys(user).length === 0} onClick={reset}>{t('resetAll')}</button>
        {status.kind === 'saved' ? <span className="dar-success" role="status">{t('saved')}</span> : null}
        {status.kind === 'failed' ? <span className="dar-error" role="alert">{t('saveFailed')}</span> : null}
      </div>
    </div>
  )
}

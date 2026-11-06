import { Fragment as _Fragment, jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { diffOps, parseDraft, resetOps, resolveSection, toDraft } from './draft.js';
import { zh } from './locales.js';
/** Edits stay local until Save; every write carries the revision it was read at. */
export function AutoRetrySettings(props) {
    const t = props.t ?? ((key) => zh[key] ?? key);
    const snapshot = useSyncExternalStore(props.form.subscribe.bind(props.form), () => props.form.getSnapshot());
    const current = useMemo(() => resolveSection(snapshot.value), [snapshot.value]);
    const accepted = useMemo(() => toDraft(current), [current]);
    const [draft, setDraft] = useState(accepted);
    const [dirty, setDirty] = useState(false);
    const [errors, setErrors] = useState({});
    const [status, setStatus] = useState({ kind: 'idle' });
    const id = useId();
    // Follow Host changes (another window, a reset) until the user starts editing.
    useEffect(() => { if (!dirty)
        setDraft(accepted); }, [accepted, dirty]);
    if (props.view === 'summary')
        return _jsx(_Fragment, { children: t('intro') });
    if (snapshot.status === 'loading')
        return _jsx("div", { className: "dar-settings", children: _jsx("p", { className: "dar-hint", children: t('loading') }) });
    if (snapshot.status === 'unavailable')
        return _jsx("div", { className: "dar-settings", children: _jsx("p", { className: "dar-hint", children: t('unavailable') }) });
    const disabled = !snapshot.writable || status.kind === 'saving';
    const user = (snapshot.user && typeof snapshot.user === 'object' ? snapshot.user : {});
    const edit = (key, value) => {
        setDraft(previous => ({ ...previous, [key]: value }));
        setDirty(true);
        setErrors(previous => ({ ...previous, [key]: undefined }));
        if (status.kind !== 'saving')
            setStatus({ kind: 'idle' });
    };
    const write = async (ops) => {
        if (ops.length === 0) {
            setDirty(false);
            return;
        }
        setStatus({ kind: 'saving' });
        try {
            const ok = await props.form.mutate(ops, snapshot.revision);
            setStatus({ kind: ok ? 'saved' : 'failed' });
            if (ok)
                setDirty(false);
        }
        catch {
            setStatus({ kind: 'failed' });
        }
    };
    const save = () => {
        const parsed = parseDraft(draft, current);
        if (parsed.errors) {
            setErrors(parsed.errors);
            return;
        }
        void write(diffOps(current, parsed.settings));
    };
    const reset = () => {
        if (!window.confirm(t('resetConfirm')))
            return;
        setErrors({});
        void write(resetOps(snapshot.user));
    };
    const error = (key) => {
        const entry = errors[key];
        return entry ? _jsxs("small", { className: "dar-error", role: "alert", children: [t(entry.key), entry.detail ?? ''] }) : null;
    };
    const changed = (...fields) => fields.some(field => field in user)
        ? _jsx("span", { className: "dar-badge", children: t('overridden') }) : null;
    const field = (key, label, input, hint, overrideFields = []) => (_jsxs("div", { className: "dar-field", children: [_jsxs("label", { htmlFor: `${id}-${key}`, children: [label, changed(...overrideFields)] }), input, hint ? _jsx("small", { children: hint }) : null, error(key)] }));
    const text = (key, inputMode) => (_jsx("input", { id: `${id}-${key}`, type: "text", inputMode: inputMode, value: draft[key], disabled: disabled, "aria-invalid": errors[key] ? true : undefined, onChange: event => edit(key, event.target.value) }));
    const area = (key, rows) => (_jsx("textarea", { id: `${id}-${key}`, rows: rows, spellCheck: false, value: draft[key], disabled: disabled, "aria-invalid": errors[key] ? true : undefined, onChange: event => edit(key, event.target.value) }));
    const toggle = (key, label, hint) => (_jsxs("label", { className: "dar-toggle", children: [_jsx("input", { type: "checkbox", checked: draft[key], disabled: disabled, onChange: event => edit(key, event.target.checked) }), _jsxs("span", { children: [_jsxs("span", { children: [label, changed(key)] }), _jsx("small", { children: hint })] })] }));
    return (_jsxs("div", { className: "dar-settings", children: [_jsx("p", { children: t('intro') }), !snapshot.writable ? _jsx("p", { className: "dar-hint", children: t('readOnly') }) : null, toggle('enabled', t('enabled'), t('enabledHint')), _jsxs("div", { className: "dar-grid", children: [field('maxRetries', t('maxRetries'), text('maxRetries', 'numeric'), t('maxRetriesHint'), ['maxRetries']), field('initialDelay', t('initialDelay'), text('initialDelay', 'decimal'), t('initialDelayHint'), ['initialDelayMs']), field('maxDelay', t('maxDelay'), text('maxDelay', 'decimal'), undefined, ['maxDelayMs'])] }), toggle('respectRetryAfter', t('respectRetryAfter'), t('respectRetryAfterHint')), _jsxs("fieldset", { children: [_jsx("legend", { children: t('rules') }), _jsx("p", { className: "dar-hint", children: t('rulesHint') }), field('statusCodes', t('statusCodes'), area('statusCodes', 2), t('statusCodesHint'), ['statusCodes']), field('codes', t('codes'), area('codes', 2), t('codesHint'), ['codes']), field('messagePatterns', t('patterns'), area('messagePatterns', 5), t('patternsHint'), ['messagePatterns']), field('excludeCodes', t('excludeCodes'), area('excludeCodes', 3), t('excludeCodesHint'), ['excludeCodes']), field('providers', t('providers'), text('providers'), t('providersHint'), ['providers'])] }), _jsxs("div", { className: "dar-actions", children: [_jsx("button", { type: "button", "data-action": "save", disabled: disabled || !dirty, onClick: save, children: status.kind === 'saving' ? t('saving') : t('save') }), _jsx("button", { type: "button", disabled: disabled || !dirty, onClick: () => { setDraft(accepted); setDirty(false); setErrors({}); setStatus({ kind: 'idle' }); }, children: t('discard') }), _jsx("button", { type: "button", disabled: disabled || Object.keys(user).length === 0, onClick: reset, children: t('resetAll') }), status.kind === 'saved' ? _jsx("span", { className: "dar-success", role: "status", children: t('saved') }) : null, status.kind === 'failed' ? _jsx("span", { className: "dar-error", role: "alert", children: t('saveFailed') }) : null] })] }));
}

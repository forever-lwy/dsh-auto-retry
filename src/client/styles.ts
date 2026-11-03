export const styles = `
.dar-settings{max-width:900px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary,inherit);font-size:14px;line-height:1.6}
.dar-settings p{margin:6px 0 14px}.dar-settings fieldset{border:1px solid var(--dsw-alias-border-primary,#8885);border-radius:12px;padding:16px;margin:18px 0;min-width:0}.dar-settings legend{font-weight:600;padding:0 7px}
.dar-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px 18px}
.dar-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;min-width:0}
.dar-field input,.dar-field textarea{box-sizing:border-box;min-width:0;width:100%;border:1px solid var(--dsw-alias-border-primary,#8886);border-radius:7px;padding:8px 10px;background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit}
.dar-field textarea{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;resize:vertical}
.dar-field [aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary,#d54941)}
.dar-toggle{display:flex;align-items:flex-start;gap:8px;margin:10px 0 16px;cursor:pointer}.dar-toggle input{margin-top:5px}.dar-toggle>span{display:flex;flex-direction:column}
.dar-settings button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-primary,#8886);background:var(--dsw-alias-bg-secondary,transparent);border-radius:7px;padding:7px 12px;cursor:pointer}
.dar-settings button:disabled{cursor:default;opacity:.55}
.dar-settings input:focus-visible,.dar-settings textarea:focus-visible,.dar-settings button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:2px}
.dar-settings [data-action=save]{background:var(--dsw-alias-brand-primary,#4d6bfe);color:white;border-color:transparent}
.dar-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.dar-hint,.dar-field small,.dar-toggle small{font-size:12px;color:var(--dsw-alias-label-secondary,#888)}
.dar-badge{margin-left:8px;font-size:11px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-bg-secondary,#8882);color:var(--dsw-alias-label-secondary,#888)}
.dar-error{color:var(--dsw-alias-state-error-primary,#d54941);overflow-wrap:anywhere}.dar-success{color:var(--dsw-alias-state-success-primary,#16945f)}
`

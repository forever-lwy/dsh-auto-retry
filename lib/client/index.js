import { AutoRetrySettings } from './Settings.js';
import { zh, en } from './locales.js';
import { styles } from './styles.js';
export const name = 'dsh-auto-retry-client';
export const inject = ['slots', 'locale', 'configForms'];
/** npm package name: the key of this bundle's page on the Plugins page. */
const PACKAGE = '@forever-lwy/dsh-auto-retry';
/** Settings namespace: the row id declared in cordis.patch.yml. */
const ENTRY = 'auto-retry';
const namespace = 'dshAutoRetry';
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(namespace, 'zh', zh), 'auto-retry: Chinese');
    ctx.effect(() => ctx.locale.register(namespace, 'en', en), 'auto-retry: English');
    ctx.effect(() => {
        const node = document.createElement('style');
        node.dataset.plugin = PACKAGE;
        node.textContent = styles;
        document.head.appendChild(node);
        return () => node.remove();
    }, 'auto-retry: styles');
    const t = ctx.locale.bind(namespace);
    const form = ctx.configForms.get(ENTRY);
    // Only while the Host row runs: a disabled row leaves no stale page behind.
    ctx.effect(() => ctx.configForms.whileServed([ENTRY], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: PACKAGE,
        inject: () => ({ form, t }),
    }, AutoRetrySettings))), 'auto-retry: settings page');
}
export { AutoRetrySettings } from './Settings.js';

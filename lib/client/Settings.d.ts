import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client';
export interface SettingsProps {
    form: ConfigForm<unknown>;
    t?: (key: string) => string;
    view?: 'summary' | 'page';
}
/** Edits stay local until Save; every write carries the revision it was read at. */
export declare function AutoRetrySettings(props: SettingsProps): import("react").JSX.Element;

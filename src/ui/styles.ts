/**
 * Runtime styles for the elements src/ui/settings.ts injects into the Settings
 * page. The configuration dialog is styled by styles/mediasoup-vtt.css.
 */

/** Class names of the elements injected into the Settings page. */
export const SETTINGS_HELP_CLASS = 'mediasoup-settings-help';
export const STATUS_INDICATOR_CLASS = 'mediasoup-status-indicator';

export const STYLE_ELEMENT_ID = 'mediasoup-vtt-styles';

const STYLES = `
.${SETTINGS_HELP_CLASS} {
  margin: 0.75rem 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border, #7a7971);
  border-radius: 4px;
  line-height: 1.4;
}
.${SETTINGS_HELP_CLASS} h4 {
  display: flex;
  align-items: center;
  gap: 0.5em;
  margin: 0 0 0.5rem;
}
.${SETTINGS_HELP_CLASS} ol {
  margin: 0 0 0.5rem;
  padding-left: 1.5em;
}
.${STATUS_INDICATOR_CLASS} {
  margin-left: auto;
  padding: 1px 8px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: bold;
}
.${STATUS_INDICATOR_CLASS}[data-state="connected"] {
  background: #d4edda;
  color: #155724;
}
.${STATUS_INDICATOR_CLASS}[data-state="active"] {
  background: #fff3cd;
  color: #856404;
}
.${STATUS_INDICATOR_CLASS}[data-state="inactive"] {
  background: #f8d7da;
  color: #721c24;
}
`;

/** Inject (or replace) the module's runtime stylesheet. Safe to call repeatedly. */
export function injectStyles(): void {
  document.getElementById(STYLE_ELEMENT_ID)?.remove();
  const styleElement = document.createElement('style');
  styleElement.id = STYLE_ELEMENT_ID;
  styleElement.textContent = STYLES;
  document.head.appendChild(styleElement);
}

import {
  getWorkspaceCapabilityLabel,
  type WorkspaceTrustState,
} from "../shared/workspace-trust";

export const sharedWebviewStyles = `
  :root {
    color-scheme: light dark;
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    font-family: var(--vscode-font-family);
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
  }

  button,
  input,
  textarea {
    font: inherit;
  }

  .shell {
    display: grid;
    gap: 12px;
    min-height: 100vh;
    padding: 16px;
  }

  .shell--preview {
    max-width: 1080px;
  }

  .shell--sidebar {
    align-content: start;
    height: calc(100vh - 32px);
    min-height: 0;
    overflow: hidden;
  }

  .eyebrow {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .card {
    display: grid;
    gap: 12px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 12px;
    padding: 12px;
    background: color-mix(in srgb, var(--vscode-editorWidget-background) 82%, transparent);
    box-shadow: 0 10px 30px color-mix(in srgb, var(--vscode-editor-background) 78%, transparent);
  }

  .hero {
    gap: 8px;
  }

  .hero h1,
  .preview-shell h1 {
    margin: 0;
    font-size: 18px;
    line-height: 1.25;
  }

  .hero p,
  .preview-shell p,
  .bridge-note,
  .composer-hint,
  .provenance__detail,
  .message__meta,
  .message__reasoning-body {
    color: var(--vscode-descriptionForeground);
    line-height: 1.45;
  }

  .bridge-note {
    font-size: 12px;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .section-title {
    font-size: 13px;
    font-weight: 600;
  }

  .section-caption {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }

  .conversation {
    gap: 10px;
  }

  .message-list {
    display: grid;
    gap: 12px;
  }

  .message {
    display: grid;
    gap: 6px;
    max-width: 100%;
  }

  .message--user {
    justify-items: end;
  }

  .message__bubble {
    display: grid;
    gap: 8px;
    max-width: min(100%, 38rem);
    border-radius: 12px;
    padding: 12px;
  }

  .message--assistant .message__bubble {
    background: transparent;
    padding-inline: 0;
  }

  .message--user .message__bubble {
    background: color-mix(in srgb, var(--vscode-inputOption-activeBackground) 45%, var(--vscode-editorWidget-background));
    border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 35%, var(--vscode-panel-border));
  }

  .message__content {
    margin: 0;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .message__chips,
  .provenance__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
    border-radius: 999px;
    padding: 2px 8px;
    background: color-mix(in srgb, var(--vscode-badge-background) 16%, transparent);
    color: var(--vscode-editor-foreground);
    font-size: 11px;
    line-height: 1.3;
  }

  .chip__label {
    color: var(--vscode-descriptionForeground);
  }

  .message__reasoning {
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
    border-radius: 10px;
    overflow: hidden;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 48%, transparent);
  }

  .message__reasoning summary {
    cursor: default;
    list-style: none;
    padding: 8px 10px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    font-weight: 500;
  }

  .message__reasoning summary::-webkit-details-marker {
    display: none;
  }

  .message__reasoning-body {
    padding: 0 10px 10px;
    font-size: 12px;
  }

  .composer {
    gap: 8px;
  }

  .composer__input {
    width: 100%;
    min-height: 72px;
    resize: none;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 12px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--vscode-input-background) 82%, transparent);
    color: var(--vscode-input-foreground);
  }

  .composer__input::placeholder {
    color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground));
  }

  .composer__actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .backend-card {
    gap: 10px;
  }

  .backend-card__meta,
  .backend-card__detail {
    margin: 0;
    color: var(--vscode-descriptionForeground);
    line-height: 1.45;
    font-size: 12px;
  }

  .backend-card__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 32px;
    border-radius: 8px;
    border: 1px solid var(--vscode-button-border, transparent);
    padding: 0 12px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    font-size: 12px;
    font-weight: 600;
  }

  .button[disabled] {
    opacity: 0.72;
  }

  .provenance-list {
    display: grid;
    gap: 12px;
  }

  .provenance-item {
    position: relative;
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    gap: 10px;
    padding-bottom: 12px;
  }

  .provenance-item:last-child {
    padding-bottom: 0;
  }

  .provenance-item:not(:last-child)::after {
    content: "";
    position: absolute;
    left: 9px;
    top: 22px;
    bottom: -2px;
    width: 1px;
    background: var(--vscode-panel-border);
  }

  .provenance__dot {
    position: relative;
    z-index: 1;
    display: inline-flex;
    width: 18px;
    height: 18px;
    border-radius: 999px;
    border: 2px solid var(--vscode-editor-background);
  }

  .provenance__dot--user_query {
    background: var(--vscode-testing-iconPassed);
  }

  .provenance__dot--delegation_start {
    background: var(--vscode-textLink-foreground);
  }

  .provenance__dot--tool_call {
    background: var(--vscode-badge-background);
  }

  .provenance__dot--delegation_complete {
    background: var(--vscode-charts-green);
  }

  .provenance__dot--assistant_response {
    background: var(--vscode-charts-blue);
  }

  .provenance__row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .provenance__label {
    font-size: 12px;
    font-weight: 600;
  }

  .provenance__time {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }

  .provenance__detail {
    margin-top: 4px;
    font-size: 12px;
  }

  .preview-shell {
    display: grid;
    gap: 12px;
  }

  .preview-stack {
    display: grid;
    gap: 12px;
  }

  .preview-stack--lg {
    gap: 16px;
  }

  .preview-banner,
  .preview-card {
    display: grid;
    gap: 10px;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 14px;
    background: color-mix(in srgb, var(--vscode-editorWidget-background) 86%, transparent);
    box-shadow: 0 10px 30px color-mix(in srgb, var(--vscode-editor-background) 82%, transparent);
    padding: 14px;
  }

  .preview-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .preview-title,
  .preview-subtitle {
    margin: 0;
    font-size: 16px;
    line-height: 1.3;
  }

  .preview-subtitle {
    font-size: 13px;
  }

  .preview-copy,
  .preview-sequence-description,
  .preview-note,
  .preview-empty-output,
  .preview-list {
    margin: 0;
    color: var(--vscode-descriptionForeground);
    line-height: 1.5;
  }

  .preview-markdown__body {
    overflow: auto;
  }

  .preview-markdown__body > *:first-child {
    margin-top: 0;
  }

  .preview-markdown__body > *:last-child {
    margin-bottom: 0;
  }

  .preview-markdown__body h1,
  .preview-markdown__body h2,
  .preview-markdown__body h3,
  .preview-markdown__body h4 {
    margin: 0 0 8px;
    line-height: 1.25;
  }

  .preview-markdown__body p,
  .preview-markdown__body li,
  .preview-markdown__body blockquote {
    line-height: 1.6;
  }

  .preview-markdown__body ul,
  .preview-markdown__body ol {
    margin: 0;
    padding-left: 20px;
  }

  .preview-markdown__body blockquote {
    margin: 0;
    border-left: 3px solid var(--vscode-textLink-foreground);
    padding-left: 12px;
    color: var(--vscode-descriptionForeground);
  }

  .preview-markdown__body code,
  .preview-pre,
  .preview-sequence {
    font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
  }

  .preview-markdown__body pre,
  .preview-pre {
    overflow: auto;
    border-radius: 12px;
    padding: 12px;
    background: color-mix(in srgb, var(--vscode-textCodeBlock-background) 88%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
    font-size: 12px;
    line-height: 1.55;
    margin: 0;
  }

  .preview-markdown__body :not(pre) > code {
    border-radius: 6px;
    padding: 2px 6px;
    background: color-mix(in srgb, var(--vscode-textCodeBlock-background) 70%, transparent);
  }

  .hljs-keyword,
  .hljs-selector-tag,
  .hljs-literal,
  .hljs-title.function_ {
    color: var(--vscode-symbolIcon-keywordForeground);
  }

  .hljs-string,
  .hljs-title,
  .hljs-section,
  .hljs-attribute,
  .hljs-symbol,
  .hljs-bullet,
  .hljs-addition {
    color: var(--vscode-symbolIcon-stringForeground);
  }

  .hljs-number,
  .hljs-meta,
  .hljs-link {
    color: var(--vscode-symbolIcon-numberForeground);
  }

  .hljs-comment,
  .hljs-quote,
  .hljs-deletion {
    color: var(--vscode-descriptionForeground);
  }

  .hljs-variable,
  .hljs-template-variable,
  .hljs-type,
  .hljs-built_in {
    color: var(--vscode-symbolIcon-variableForeground);
  }

  .preview-markdown__body table,
  .preview-table {
    width: 100%;
    border-collapse: collapse;
  }

  .preview-markdown__body th,
  .preview-markdown__body td,
  .preview-table th,
  .preview-table td {
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
    padding: 8px 10px;
    text-align: left;
    vertical-align: top;
  }

  .preview-markdown__body th,
  .preview-table th {
    position: sticky;
    top: 0;
    background: color-mix(in srgb, var(--vscode-editor-background) 94%, transparent);
    font-size: 12px;
    font-weight: 600;
  }

  .preview-table-wrap {
    overflow: auto;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
  }

  .preview-table td {
    max-width: 280px;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .preview-summary {
    cursor: default;
    font-size: 12px;
    font-weight: 600;
  }

  .preview-list {
    padding-left: 18px;
  }

  .preview-sequence-card,
  .preview-latex-layout,
  .preview-bcf-grid {
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  }

  .preview-latex-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: end;
  }

  .preview-field {
    display: grid;
    gap: 6px;
    min-width: 180px;
  }

  .preview-field__label {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .preview-select {
    min-height: 32px;
    border-radius: 8px;
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    padding: 0 10px;
  }

  .preview-log-card {
    gap: 8px;
  }

  .preview-log-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .preview-meta-grid {
    display: grid;
    gap: 10px;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    margin: 0;
  }

  .preview-meta-grid dt {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    font-weight: 600;
    margin-bottom: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .preview-meta-grid dd {
    margin: 0;
    line-height: 1.5;
  }

  .preview-sequence-header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 10px;
    align-items: start;
  }

  .preview-sequence-id {
    margin: 0;
    font-size: 13px;
  }

  .preview-sequence-body {
    display: grid;
    gap: 12px;
  }

  .preview-sequence {
    display: block;
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 12px;
    line-height: 1.6;
  }

  .preview-sequence-more {
    color: var(--vscode-descriptionForeground);
  }

  .preview-quality {
    display: flex;
    flex-wrap: wrap;
    gap: 1px;
    align-items: end;
    min-height: 24px;
  }

  .preview-quality-bar {
    width: 4px;
    border-radius: 999px;
    display: inline-block;
  }

  .preview-quality-bar--high {
    background: color-mix(in srgb, var(--vscode-testing-iconPassed) 75%, transparent);
  }

  .preview-quality-bar--mid {
    background: color-mix(in srgb, var(--vscode-testing-iconQueued) 75%, transparent);
  }

  .preview-quality-bar--low {
    background: color-mix(in srgb, var(--vscode-testing-iconFailed) 75%, transparent);
  }

  .preview-base--adenine,
  .preview-base--hydrophobic {
    color: var(--vscode-testing-iconPassed);
  }

  .preview-base--cytosine,
  .preview-aa--polar {
    color: var(--vscode-charts-purple);
  }

  .preview-base--guanine,
  .preview-aa--basic {
    color: var(--vscode-charts-yellow);
  }

  .preview-base--thymine,
  .preview-base--uracil,
  .preview-aa--acidic {
    color: var(--vscode-testing-iconFailed);
  }

  .preview-base--unknown,
  .preview-aa--special,
  .preview-aa--aromatic {
    color: var(--vscode-editor-foreground);
  }

  .preview-latex-output {
    min-height: 420px;
    align-content: start;
  }

  .preview-pdf-frame {
    width: 100%;
    min-height: 640px;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 85%, transparent);
    border-radius: 12px;
    background: var(--vscode-editor-background);
  }

  .preview-empty-output {
    display: grid;
    place-items: center;
    min-height: 360px;
    border-radius: 12px;
    border: 1px dashed color-mix(in srgb, var(--vscode-panel-border) 85%, transparent);
    background: color-mix(in srgb, var(--vscode-editor-background) 92%, transparent);
    text-align: center;
    padding: 20px;
  }

  .preview-mermaid-error::after {
    content: "Mermaid rendering failed — raw diagram text shown.";
    display: block;
    margin-top: 8px;
    color: var(--vscode-testing-iconFailed);
    font-size: 11px;
  }

  .bridge-status {
    display: grid;
    gap: 6px;
  }

  .bridge-status h2 {
    margin: 0;
    font-size: 13px;
  }

  .bridge-meta {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }

  .trust-banner {
    display: grid;
    gap: 10px;
    border-radius: 12px;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
    padding: 12px;
    background: color-mix(in srgb, var(--vscode-editorWidget-background) 86%, transparent);
  }

  .trust-banner--restricted {
    border-color: color-mix(in srgb, var(--vscode-testing-iconFailed) 45%, var(--vscode-panel-border));
    background: color-mix(in srgb, var(--vscode-editorWarning-background) 26%, transparent);
  }

  .trust-banner--trusted {
    border-color: color-mix(in srgb, var(--vscode-testing-iconPassed) 35%, var(--vscode-panel-border));
  }

  .trust-banner__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
  }

  .trust-banner__title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }

  .trust-banner__copy {
    margin: 0;
    color: var(--vscode-descriptionForeground);
    line-height: 1.45;
  }

  .trust-list {
    display: grid;
    gap: 6px;
    margin: 0;
    padding-left: 18px;
    color: var(--vscode-descriptionForeground);
  }

  .sidebar-chat {
    display: grid;
    gap: 12px;
    height: 100%;
    min-height: 0;
    align-content: start;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding-right: 4px;
  }

  .conversation-card {
    display: grid;
    gap: 12px;
    min-height: 0;
    padding: 0;
    overflow: hidden;
    flex-shrink: 0;
  }

  .conversation-frame {
    min-height: 0;
    overflow-y: auto;
    padding: 16px;
  }

  .conversation-frame--empty {
    display: grid;
    place-items: center;
  }

  .empty-state {
    display: grid;
    gap: 8px;
    justify-items: center;
    padding: 24px;
    text-align: center;
  }

  .empty-state__title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .empty-state__copy {
    margin: 0;
    max-width: 28ch;
    color: var(--vscode-descriptionForeground);
    line-height: 1.5;
  }

  .composer-shell {
    display: grid;
    gap: 10px;
    border: 1px solid color-mix(in srgb, var(--vscode-input-border, var(--vscode-panel-border)) 88%, transparent);
    border-radius: 14px;
    padding: 10px;
    background: color-mix(in srgb, var(--vscode-input-background) 84%, transparent);
    box-shadow: 0 10px 30px color-mix(in srgb, var(--vscode-editor-background) 82%, transparent);
  }

  .composer-shell:focus-within {
    border-color: var(--vscode-focusBorder);
  }

  .composer__input {
    min-height: 88px;
    border: 0;
    background: transparent;
    padding: 2px 4px;
    color: var(--vscode-input-foreground);
  }

  .composer__input:focus {
    outline: none;
  }

  .composer__footer {
    display: grid;
    gap: 8px;
    border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
    padding-top: 8px;
  }

  .control-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }

  .control-pill,
  .target-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 86%, transparent);
    border-radius: 10px;
    padding: 6px 10px;
    background: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent);
    color: var(--vscode-editor-foreground);
    font-size: 12px;
    line-height: 1.3;
  }

  .control-pill--muted {
    color: var(--vscode-descriptionForeground);
  }

  .control-pill__label {
    color: var(--vscode-descriptionForeground);
  }

  .control-pill__value {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .target-pill {
    padding: 0;
    overflow: hidden;
  }

  .target-pill__select {
    min-height: 34px;
    border: 0;
    background: transparent;
    color: inherit;
    padding: 0 10px;
    font: inherit;
  }

  .composer__meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .composer__hint {
    margin: 0;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    line-height: 1.45;
  }

  .send-button {
    min-width: 80px;
    min-height: 26px;
    padding-block: 0;
  }

  .service-notice {
    display: grid;
    gap: 10px;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 86%, transparent);
    border-radius: 12px;
    padding: 12px;
    background: color-mix(in srgb, var(--vscode-editorWidget-background) 86%, transparent);
  }

  .service-notice--restricted {
    border-color: color-mix(in srgb, var(--vscode-testing-iconFailed) 40%, var(--vscode-panel-border));
    background: color-mix(in srgb, var(--vscode-editorWarning-background) 24%, transparent);
  }

  .service-notice__row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .service-notice__title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }

  .service-notice__copy {
    margin: 0;
    color: var(--vscode-descriptionForeground);
    line-height: 1.45;
    font-size: 12px;
  }

  .service-notice__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .sidebar-drawer {
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 86%, transparent);
    border-radius: 12px;
    background: color-mix(in srgb, var(--vscode-editorWidget-background) 78%, transparent);
    overflow: hidden;
  }

  .sidebar-drawer[open] {
    max-height: 33vh;
  }

  .sidebar-drawer summary {
    list-style: none;
    cursor: default;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 12px;
    font-size: 12px;
    font-weight: 600;
  }

  .sidebar-drawer summary::-webkit-details-marker {
    display: none;
  }

  .sidebar-drawer__body {
    border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
    padding: 12px;
    max-height: calc(33vh - 44px);
    overflow: auto;
  }

  .sidebar-chat {
    display: grid;
    gap: 10px;
    height: calc(100vh - 32px);
    min-height: 0;
    grid-template-rows: auto auto minmax(0, 1fr) auto auto;
    align-content: start;
  }

  .chat-tabbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
    padding: 0 2px 10px;
  }

  .chat-tablist {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .chat-tab {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid transparent;
    border-radius: 8px;
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-editor-foreground);
    background: color-mix(in srgb, var(--vscode-badge-background) 12%, transparent);
  }

  .chat-tab--active {
    border-color: color-mix(in srgb, var(--vscode-focusBorder) 42%, transparent);
    background: color-mix(in srgb, var(--vscode-focusBorder) 16%, transparent);
  }

  .chat-tab__badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    border-radius: 999px;
    padding: 0 6px;
    background: color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
    color: var(--vscode-focusBorder);
    font-size: 10px;
    line-height: 1;
  }

  .chat-tab__meta {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }

  .chat-panel {
    display: grid;
    grid-template-rows: minmax(0, 1fr);
    min-height: 0;
    height: 100%;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
    border-radius: 14px;
    background: color-mix(in srgb, var(--vscode-editorWidget-background) 74%, transparent);
    overflow: hidden;
  }

  .chat-panel--workflows {
    min-height: 420px;
  }

  .workflows-panel {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-height: 0;
  }

  .workflows-toolbar {
    display: grid;
    gap: 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
    padding: 12px;
  }

  .workflows-search {
    display: grid;
    gap: 4px;
  }

  .workflows-search__label,
  .workflow-field__label,
  .workflow-detail__eyebrow,
  .workflow-group__title {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    line-height: 1.3;
  }

  .workflows-search__input,
  .workflow-field__input,
  .workflow-field__textarea {
    width: 100%;
    border: 1px solid color-mix(in srgb, var(--vscode-input-border, var(--vscode-panel-border)) 88%, transparent);
    border-radius: 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    padding: 8px 10px;
    font: inherit;
  }

  .workflow-field__textarea {
    min-height: 88px;
    resize: vertical;
  }

  .workflows-categories {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .workflows-category-chip {
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
    border-radius: 999px;
    padding: 4px 8px;
    background: color-mix(in srgb, var(--vscode-badge-background) 12%, transparent);
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
  }

  .workflows-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(220px, 0.9fr);
    min-height: 0;
    overflow: hidden;
  }

  .workflows-list,
  .workflow-detail {
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }

  .workflows-list {
    padding: 12px;
  }

  .workflow-detail {
    display: grid;
    align-content: start;
    gap: 12px;
    border-left: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
    padding: 12px;
    background: color-mix(in srgb, var(--vscode-editor-background) 72%, transparent);
  }

  .workflow-group {
    display: grid;
    gap: 8px;
  }

  .workflow-group + .workflow-group {
    margin-top: 16px;
  }

  .workflow-group__items {
    display: grid;
    gap: 6px;
  }

  .workflow-card {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 10px;
    align-items: start;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
    border-radius: 10px;
    padding: 10px;
    background: color-mix(in srgb, var(--vscode-editorWidget-background) 60%, transparent);
    color: inherit;
    text-align: left;
  }

  .workflow-card--selected {
    border-color: color-mix(in srgb, var(--vscode-focusBorder) 46%, transparent);
    background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
  }

  .workflow-card__glyph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent);
    color: var(--vscode-focusBorder);
    font-size: 11px;
    font-weight: 700;
  }

  .workflow-card__body,
  .workflow-detail__header,
  .workflow-detail__fields {
    display: grid;
    gap: 6px;
  }

  .workflow-card__title-row,
  .workflow-controls-row,
  .workflow-skill-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
  }

  .workflow-card__title,
  .workflow-detail__title {
    font-size: 13px;
    font-weight: 600;
    color: var(--vscode-editor-foreground);
  }

  .workflow-card__copy,
  .workflow-detail__copy,
  .workflow-launch-note {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    line-height: 1.45;
  }

  .workflow-card__badge,
  .workflow-skill-chip {
    display: inline-flex;
    align-items: center;
    border: 1px solid color-mix(in srgb, var(--vscode-focusBorder) 24%, transparent);
    border-radius: 999px;
    padding: 2px 6px;
    background: color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent);
    color: var(--vscode-focusBorder);
    font-size: 10px;
  }

  .workflow-run-button {
    justify-self: start;
  }


  .chat-panel--settings {
    min-height: 420px;
  }

  .settings-panel {
    display: grid;
    gap: 16px;
    padding: 12px;
    min-height: 0;
    overflow: auto;
  }

  .settings-section {
    display: grid;
    gap: 10px;
  }

  .settings-section__header {
    display: grid;
    gap: 4px;
  }

  .settings-section__title {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
  }

  .settings-section__copy {
    margin: 0;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    line-height: 1.4;
  }

  .settings-section__grid {
    display: grid;
    gap: 12px;
  }

  .settings-subsection__title {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--vscode-editor-foreground);
  }

  .settings-card {
    display: grid;
    gap: 10px;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 84%, transparent);
    border-radius: 10px;
    padding: 12px;
    background: color-mix(in srgb, var(--vscode-editorWidget-background) 64%, transparent);
  }

  .settings-card__header,
  .settings-card__actions,
  .settings-toggle--inline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .settings-card__title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
  }

  .settings-card__copy,
  .settings-secret-status {
    margin: 0;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    line-height: 1.4;
  }

  .settings-fields {
    display: grid;
    gap: 8px;
  }

  .settings-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
  }

  .settings-field {
    display: grid;
    gap: 4px;
  }

  .settings-field__label {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
  }

  .settings-field__select,
  .settings-field__input {
    min-height: 28px;
    border: 1px solid color-mix(in srgb, var(--vscode-input-border, var(--vscode-panel-border)) 88%, transparent);
    border-radius: 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    padding: 0 10px;
    font: inherit;
  }

  .conversation-frame {
    min-height: 0;
    height: 100%;
    max-height: 100%;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 16px;
  }

  .chat-footer-stack {
    display: grid;
    gap: 8px;
    min-height: 0;
  }

  .chat-footer-stack__composer,
  .chat-footer-stack__provenance {
    display: grid;
    min-height: 0;
  }

  .provenance-list--scroll {
    max-height: calc(33vh - 68px);
    overflow: auto;
    overscroll-behavior: contain;
  }

  .conversation-frame--empty {
    display: grid;
    place-items: center;
  }

  .empty-state {
    display: grid;
    gap: 8px;
    justify-items: center;
    padding: 24px;
    text-align: center;
  }

  .empty-state__title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .empty-state__copy {
    margin: 0;
    max-width: 30ch;
    color: var(--vscode-descriptionForeground);
    line-height: 1.5;
  }

  .composer-shell {
    display: grid;
    gap: 10px;
    border: 1px solid color-mix(in srgb, var(--vscode-input-border, var(--vscode-panel-border)) 88%, transparent);
    border-radius: 14px;
    padding: 10px;
    background: color-mix(in srgb, var(--vscode-input-background) 84%, transparent);
    box-shadow: 0 10px 30px color-mix(in srgb, var(--vscode-editor-background) 82%, transparent);
    position: relative;
    z-index: 1;
  }

  .prompt-input {
    min-height: 0;
  }

  .sidebar-chat > .sidebar-drawer {
    margin-top: 6px;
    align-self: start;
  }

  .composer-shell:focus-within {
    border-color: var(--vscode-focusBorder);
  }

  .composer__input {
    min-height: 3.6em;
    max-height: 33vh;
    border: 0;
    background: transparent;
    padding: 2px 4px;
    color: var(--vscode-input-foreground);
    resize: none;
  }

  .composer__input:focus {
    outline: none;
  }

  .composer__footer {
    display: grid;
    gap: 3px;
    border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 82%, transparent);
    padding-top: 3px;
  }

  .control-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
  }

  .composer-control,
  .composer-control--select {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 86%, transparent);
    border-radius: 5px;
    padding: 0 4px;
    background: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent);
    color: var(--vscode-editor-foreground);
    font-size: 9px;
    line-height: 1;
  }

  .composer-control--muted {
    color: var(--vscode-descriptionForeground);
  }

  .composer-control__label {
    color: var(--vscode-descriptionForeground);
  }

  .composer-control__value {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .composer-control--select {
    padding: 0;
    overflow: hidden;
  }

  .composer-control__select {
    min-height: 14px;
    height: 14px;
    border: 0;
    background: transparent;
    color: inherit;
    padding: 0 4px;
    font: inherit;
    line-height: 1;
    appearance: none;
    -webkit-appearance: none;
  }


.composer-picker {
  position: relative;
  display: inline-flex;
  min-width: 0;
}

.composer-picker[open] {
  z-index: 2;
}

.composer-picker__summary {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  list-style: none;
  cursor: pointer;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 86%, transparent);
  border-radius: 5px;
  padding: 0 4px;
  background: color-mix(in srgb, var(--vscode-editorWidget-background) 72%, transparent);
  color: var(--vscode-editor-foreground);
  font-size: 9px;
  line-height: 1;
  min-height: 14px;
}

.composer-picker__summary::-webkit-details-marker {
  display: none;
}

.composer-picker__label {
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
}

.composer-picker__menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 4px);
  width: min(340px, 80vw);
  max-height: 220px;
  overflow: auto;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 88%, transparent);
  border-radius: 8px;
  padding: 4px;
  background: var(--vscode-editorWidget-background);
  box-shadow: 0 10px 24px color-mix(in srgb, var(--vscode-editor-background) 78%, transparent);
}

.composer-picker__list {
  display: grid;
  gap: 2px;
}

.composer-picker__option {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 4px;
  align-items: start;
  padding: 1px 2px;
  border-radius: 4px;
}

.composer-picker__option:hover {
  background: color-mix(in srgb, var(--vscode-list-hoverBackground) 72%, transparent);
}

.composer-picker__option-body {
  display: grid;
  gap: 1px;
  min-width: 0;
}

.composer-picker__option-title {
  font-size: 10px;
  color: var(--vscode-editor-foreground);
  line-height: 1.15;
}

.composer-picker__option-copy,
.composer-picker__empty {
  font-size: 9px;
  color: var(--vscode-descriptionForeground);
  line-height: 1.2;
}

  .composer__meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }

  .composer__hint {
    margin: 0;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    line-height: 1.45;
  }

  .send-button {
    min-width: 56px;
    min-height: 16px;
    padding: 0 5px;
    font-size: 9px;
    line-height: 1;
  }

`;

export function renderPreviewShell(
  heading: string,
  body: string,
  bodyIsHtml: boolean,
  bridgeStatus: string,
  kind: string,
  trust?: WorkspaceTrustState,
) {
  return `
    <main class="shell shell--preview">
      <section class="card preview-shell">
        <span class="eyebrow">K-Dense BYOK</span>
        <h1>${escapeHtml(heading)}</h1>
        ${trust ? renderTrustBanner(trust) : ""}
        ${bodyIsHtml ? body : `<p>${escapeHtml(body)}</p>`}
        <section class="bridge-status" aria-live="polite">
          <h2>Host bridge</h2>
          <p>${escapeHtml(bridgeStatus)}</p>
          <p class="bridge-meta">Typed runtime connected for the ${escapeHtml(kind)} webview surface.</p>
        </section>
      </section>
    </main>
  `;
}

function renderTrustBanner(trust: WorkspaceTrustState) {
  const blockedItems = trust.blockedCapabilities.length
    ? `<ul class="trust-list">${trust.blockedCapabilities.map((capability) => `<li>${escapeHtml(getWorkspaceCapabilityLabel(capability))}</li>`).join("")}</ul>`
    : "";

  return `
    <section class="trust-banner trust-banner--${trust.mode}" aria-label="Workspace trust status">
      <div class="trust-banner__header">
        <h2 class="trust-banner__title">${escapeHtml(trust.statusLabel)}</h2>
        <span class="chip">${escapeHtml(`Preview open: ${String(trust.capabilities.previewOpen)}`)}</span>
      </div>
      <p class="trust-banner__copy">${escapeHtml(trust.summary)}</p>
      <p class="trust-banner__copy">${escapeHtml(trust.detail)}</p>
      ${blockedItems}
    </section>
  `;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

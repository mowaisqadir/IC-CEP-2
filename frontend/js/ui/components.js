// frontend/js/ui/components.js
// Shared UI helpers: toast, spinner, empty state, etc.
// All helpers return DOM nodes or modify the document directly.
// None of them call fetch().

import { escapeHtml } from '../utils.js';

// ─── Toast ────────────────────────────────────────────────────────────────────

const TOAST_ICONS = {
  success: '✅',
  error:   '❌',
  warn:    '⚠️',
  info:    'ℹ️',
};

const TOAST_DURATION = {
  success: 3500,
  error:   6000,
  warn:    5000,
  info:    4000,
};

/**
 * Show a toast notification.
 *
 * @param {object} opts
 * @param {string}  opts.message
 * @param {string}  [opts.title]
 * @param {'success'|'error'|'warn'|'info'} [opts.type='info']
 * @param {number}  [opts.duration]  - ms before auto-dismiss (0 = never)
 * @param {string}  [opts.action]    - label for an optional action button
 * @param {Function}[opts.onAction]  - callback for the action button
 * @returns {HTMLElement} the toast element
 */
export function showToast({
  message,
  title,
  type    = 'info',
  duration,
  action,
  onAction,
} = {}) {
  const container = document.getElementById('toast-container');
  if (!container) return null;

  const ms = duration !== undefined ? duration : TOAST_DURATION[type] ?? 4000;

  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.setAttribute('role', 'alert');
  toast.innerHTML = `
    <span class="toast__icon" aria-hidden="true">${TOAST_ICONS[type] ?? 'ℹ️'}</span>
    <div class="toast__body">
      ${title ? `<div class="toast__title">${escapeHtml(title)}</div>` : ''}
      <div class="toast__msg">${escapeHtml(message)}</div>
      ${action ? `<button class="btn btn--ghost text-sm toast__action" style="padding:4px 8px;min-height:32px;margin-top:6px">${escapeHtml(action)}</button>` : ''}
    </div>
    <button class="toast__close" aria-label="Dismiss notification">✕</button>
  `;

  const dismiss = () => {
    toast.classList.add('toast--exit');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  };

  toast.querySelector('.toast__close').addEventListener('click', dismiss);

  if (action && onAction) {
    toast.querySelector('.toast__action').addEventListener('click', () => {
      onAction();
      dismiss();
    });
  }

  container.appendChild(toast);

  if (ms > 0) {
    setTimeout(dismiss, ms);
  }

  return toast;
}

// ─── Convenience wrappers ─────────────────────────────────────────────────────

export const toast = {
  success: (message, opts) => showToast({ ...opts, message, type: 'success' }),
  error:   (message, opts) => showToast({ ...opts, message, type: 'error' }),
  warn:    (message, opts) => showToast({ ...opts, message, type: 'warn' }),
  info:    (message, opts) => showToast({ ...opts, message, type: 'info' }),
};

// ─── Spinner ──────────────────────────────────────────────────────────────────

/**
 * Create a loading spinner element.
 * @param {'sm'|'md'|'lg'} [size='md']
 * @returns {HTMLElement}
 */
export function createSpinner(size = 'md') {
  const el = document.createElement('span');
  el.className = size === 'md' ? 'spinner' : `spinner spinner--${size}`;
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/**
 * Render a full-container loading state.
 * @param {string} [label]
 * @returns {HTMLElement}
 */
export function createLoadingState(label = 'Loading…') {
  const el = document.createElement('div');
  el.className = 'loading-center';
  el.innerHTML = `<div class="spinner spinner--lg" aria-hidden="true"></div>
                  <span class="text-muted">${escapeHtml(label)}</span>`;
  return el;
}

// ─── Empty state ──────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string} opts.icon
 * @param {string} opts.title
 * @param {string} [opts.message]
 * @returns {HTMLElement}
 */
export function createEmptyState({ icon, title, message }) {
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.innerHTML = `
    <div class="empty-state__icon" aria-hidden="true">${icon}</div>
    <div class="empty-state__title">${escapeHtml(title)}</div>
    ${message ? `<div class="empty-state__msg">${escapeHtml(message)}</div>` : ''}
  `;
  return el;
}

// ─── Error state ──────────────────────────────────────────────────────────────

/**
 * @param {Error|string} err
 * @param {Function}     [onRetry]
 * @returns {HTMLElement}
 */
export function createErrorState(err, onRetry) {
  const message = err instanceof Error ? err.message : String(err);
  const el = document.createElement('div');
  el.className = 'empty-state';
  el.innerHTML = `
    <div class="empty-state__icon" aria-hidden="true">⚠️</div>
    <div class="empty-state__title">Something went wrong</div>
    <div class="empty-state__msg text-error">${escapeHtml(message)}</div>
    ${onRetry ? '<button class="btn btn--secondary" style="margin-top:16px">Try again</button>' : ''}
  `;
  if (onRetry) {
    el.querySelector('button').addEventListener('click', onRetry);
  }
  return el;
}

// ─── Page header helper ───────────────────────────────────────────────────────

/**
 * Create a standard page header with title and optional action button.
 *
 * @param {object} opts
 * @param {string}       opts.title
 * @param {string}       [opts.actionLabel]
 * @param {string}       [opts.actionHref]
 * @param {Function}     [opts.onAction]
 * @returns {HTMLElement}
 */
export function createPageHeader({ title, actionLabel, actionHref, onAction }) {
  const el = document.createElement('div');
  el.className = 'page-header';

  const h = document.createElement('h1');
  h.className = 'page-header__title';
  h.textContent = title;
  el.appendChild(h);

  if (actionLabel) {
    let btn;
    if (actionHref) {
      btn = document.createElement('a');
      btn.href = actionHref;
    } else {
      btn = document.createElement('button');
      btn.type = 'button';
      if (onAction) btn.addEventListener('click', onAction);
    }
    btn.className = 'btn btn--primary';
    btn.textContent = actionLabel;
    el.appendChild(btn);
  }

  return el;
}

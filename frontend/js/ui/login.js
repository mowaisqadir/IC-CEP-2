// frontend/js/ui/login.js
// Login screen view.
// Called by router as: loginView(params, container)
//
// Responsibilities:
//   - Render the login form
//   - On submit: call auth.login(), redirect to #/projects on success
//   - Show clear offline message if navigator.onLine is false
//   - Surface auth/network errors in the UI (never swallow)

import { login } from '../auth.js';
import { NetworkError, AuthError } from '../api.js';
import { toast } from './components.js';

/**
 * @param {object}      _params     - unused (no route params on /login)
 * @param {HTMLElement} container   - #view element
 */
export async function loginView(_params, container) {
  const isOffline = !navigator.onLine;

  container.innerHTML = '';

  // ── Build the login screen DOM ───────────────────────────────────────────
  const screen = document.createElement('div');
  screen.className = 'login-screen';

  screen.innerHTML = `
    <div class="login-card">
      <div class="login-logo" aria-hidden="true">🌿</div>
      <h1 class="login-title">FieldSync</h1>
      <p class="login-subtitle">Environmental Field Research</p>

      ${isOffline ? `
        <div class="offline-banner" role="alert">
          <span aria-hidden="true">📡</span>
          <span>You're offline. You can only log in with a cached session.</span>
        </div>` : ''}

      <form id="login-form" class="stack" novalidate>
        <div class="form-group">
          <label class="form-label form-label--required" for="login-username">
            Username
          </label>
          <input
            class="form-input"
            type="text"
            id="login-username"
            name="username"
            autocomplete="username"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            required
            placeholder="e.g. j.smith"
            ${isOffline ? 'disabled' : ''}
          />
        </div>

        <div class="form-group">
          <label class="form-label form-label--required" for="login-password">
            Password
          </label>
          <input
            class="form-input"
            type="password"
            id="login-password"
            name="password"
            autocomplete="current-password"
            required
            placeholder="••••••••"
            ${isOffline ? 'disabled' : ''}
          />
        </div>

        <div id="login-error" role="alert" class="text-error text-sm" hidden></div>

        <button
          class="btn btn--primary btn--full"
          type="submit"
          id="login-btn"
          ${isOffline ? 'disabled' : ''}
        >
          Sign In
        </button>
      </form>
    </div>
  `;

  container.appendChild(screen);

  // ── Offline network listener – refresh banner if connectivity changes ────
  const handleOnline = () => {
    // Easiest: just re-render the view
    loginView(_params, container);
  };
  window.addEventListener('online', handleOnline, { once: true });

  if (isOffline) return;  // No form logic needed when fully offline

  // ── Form submission ──────────────────────────────────────────────────────
  const form    = screen.querySelector('#login-form');
  const btn     = screen.querySelector('#login-btn');
  const errDiv  = screen.querySelector('#login-error');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const username = form.username.value.trim();
    const password = form.password.value;

    // Basic client-side validation
    if (!username || !password) {
      _showError(errDiv, 'Please enter your username and password.');
      return;
    }

    _setLoading(btn, true);
    _showError(errDiv, '');

    try {
      await login(username, password);

      // Prompt for persistent storage (best-effort; ignore rejection)
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
      }

      window.location.hash = '#/projects';

    } catch (err) {
      _setLoading(btn, false);

      if (err instanceof NetworkError) {
        _showError(errDiv,
          'Could not reach the server. Check your connection and try again.');
      } else if (err instanceof AuthError) {
        _showError(errDiv,
          'Incorrect username or password. Please try again.');
      } else {
        _showError(errDiv, err.message || 'Login failed. Please try again.');
        toast.error(err.message || 'Login failed', { title: 'Error' });
      }
    }
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _setLoading(btn, loading) {
  if (loading) {
    btn.classList.add('btn--loading');
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
  } else {
    btn.classList.remove('btn--loading');
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

function _showError(div, message) {
  div.textContent = message;
  div.hidden = !message;
}

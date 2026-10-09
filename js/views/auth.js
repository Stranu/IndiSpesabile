// js/views/auth.js — Login / signup panel, rendered into a modal (design §13).
// Uses ONLY supabase.js auth helpers. NEVER calls fullSync (app.js SIGNED_IN handler is the
// sole sync driver). Error messages mapped to Italian; app stays usable anonymously. All Italian.

import { signIn, signUp } from '../supabase.js';
import { el, toast } from '../ui.js';

// Best-effort error-message mapping (on error.message) -> Italian.
function mapSignInError(error) {
  const msg = (error && error.message ? error.message : '').toLowerCase();
  if (msg.includes('invalid login') || msg.includes('invalid credentials')) {
    return 'Email o password non corretti';
  }
  if (msg.includes('not confirmed') || msg.includes('confirm')) {
    return 'Conferma prima la tua email per accedere';
  }
  return 'Accesso non riuscito, riprova';
}

function mapSignUpError(error) {
  const msg = (error && error.message ? error.message : '').toLowerCase();
  if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) {
    return 'Email già registrata, prova ad accedere';
  }
  if (msg.includes('password')) {
    return 'Password troppo debole, usane una più lunga';
  }
  if (msg.includes('email') && (msg.includes('invalid') || msg.includes('valid'))) {
    return 'Email non valida';
  }
  return 'Registrazione non riuscita, riprova';
}

// render({ close }) — close() is called on success to dismiss the hosting modal.
export function render({ close } = {}) {
  const emailInput = el('input', {
    type: 'email',
    class: 'input',
    placeholder: 'Email',
    autocomplete: 'email',
    'aria-label': 'Email',
  });
  const passwordInput = el('input', {
    type: 'password',
    class: 'input',
    placeholder: 'Password',
    autocomplete: 'current-password',
    'aria-label': 'Password',
  });

  // Persistent info line (used for the confirm-email message).
  const info = el('div', { class: 'auth-info', 'aria-live': 'polite' });

  function setBusy(busy) {
    signInBtn.disabled = busy;
    signUpBtn.disabled = busy;
  }

  async function doSignIn() {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      toast('Inserisci email e password', 'info');
      return;
    }
    setBusy(true);
    try {
      const { error } = await signIn(email, password);
      if (error) {
        console.warn('signIn error', error);
        toast(mapSignInError(error), 'error');
        return; // stay on the panel
      }
      // Success -> close the panel. The SIGNED_IN handler in app.js drives fullSync.
      if (typeof close === 'function') close();
    } catch (e) {
      console.warn('signIn threw', e);
      toast('Accesso non riuscito, riprova', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function doSignUp() {
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      toast('Inserisci email e password', 'info');
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await signUp(email, password);
      if (error) {
        console.warn('signUp error', error);
        toast(mapSignUpError(error), 'error');
        return; // stay on the panel
      }
      if (data && data.session) {
        // Auto-confirm / confirmation disabled -> signed in. Close; app.js drives fullSync.
        if (typeof close === 'function') close();
      } else {
        // Email confirmation required: keep the panel, show a persistent info message.
        // App stays fully usable anonymously at ZERO network (no session -> no sync).
        info.textContent = "Registrazione effettuata: conferma l'email per accedere";
      }
    } catch (e) {
      console.warn('signUp threw', e);
      toast('Registrazione non riuscita, riprova', 'error');
    } finally {
      setBusy(false);
    }
  }

  const signInBtn = el(
    'button',
    { type: 'button', class: 'btn btn-primary', onClick: doSignIn },
    'Accedi'
  );
  const signUpBtn = el(
    'button',
    { type: 'button', class: 'btn', onClick: doSignUp },
    'Registrati'
  );

  return el('div', { class: 'auth-view' }, [
    emailInput,
    passwordInput,
    info,
    el('div', { class: 'auth-actions' }, [signInBtn, signUpBtn]),
  ]);
}

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

/** A small recovery page shared by every branded client on this account server. */
export function passwordResetPage(site: string, nonce: string): string {
  const host = new URL(site).hostname;
  const school = host === "backtoschool.help" || host === "www.backtoschool.help";
  const name = school ? "BackToSchool.help" : host;
  const home = school ? "/#live" : "/";
  return `<!doctype html><html lang="en"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow">
  <title>Reset your password — ${escape(name)}</title>
  <style>
  :root{font-family:system-ui,sans-serif;color:#34246d;background:#f7f3e9;color-scheme:light}
  *{box-sizing:border-box}body{margin:0}header{padding:1.25rem max(1rem,calc((100% - 960px)/2));border-bottom:1px solid #ddd5e6}
  a{color:#34246d;text-underline-offset:3px}header a{font-weight:800;text-decoration:none}
  main{max-width:480px;margin:clamp(2rem,8vh,5rem) auto;padding:0 1rem 3rem}
  .card{background:#fffdf8;border:1px solid #ddd5e6;border-radius:20px;padding:clamp(1.25rem,5vw,2rem)}
  h1{font-family:Georgia,serif;font-size:2.25rem;line-height:1.1;margin:0 0 1rem}p{line-height:1.55}
  label{display:block;font-weight:650;margin:1.25rem 0 .5rem}input{width:100%;font:inherit;padding:.85rem;border:1px solid #8a829f;border-radius:10px;background:white;color:#211747}
  button{width:100%;font:inherit;font-weight:700;border:0;border-radius:30px;background:#34246d;color:white;padding:.9rem 1.1rem;margin-top:1.25rem;cursor:pointer}
  button[aria-disabled=true]{opacity:.65;cursor:wait}a:focus-visible,input:focus-visible,button:focus-visible{outline:3px solid #b14b29;outline-offset:3px}
  .help{font-size:.9rem;color:#514961}.message:empty{display:none}.error{color:#9b202a}.success{color:#215d3d}
  .back{display:inline-block;margin-top:1.5rem}[hidden]{display:none!important}
  @media(forced-colors:active){.card,button{border:1px solid CanvasText}}
  </style></head><body>
  <header><a href="${home}">${escape(name)}</a></header>
  <main><div class="card">
    <h1 id="title">Forgot your password?</h1>
    <p id="intro">Enter your account’s email address and we’ll send you a link to choose a new password.</p>
    <form id="request-form">
      <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="320" required>
      <button type="submit">Send reset link</button>
    </form>
    <form id="reset-form" hidden>
      <label for="password">New password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="8" maxlength="200" aria-describedby="password-help" required>
      <p class="help" id="password-help">Use at least 8 characters, including a number.</p>
      <label for="confirm">Confirm new password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="200" required>
      <button type="submit">Save new password</button>
    </form>
    <p id="status" class="message success" role="status" aria-live="polite"></p>
    <p id="error" class="message error" role="alert"></p>
    <p id="another" hidden><a href="/reset-password">Request a new reset link</a></p>
    <a class="back" id="back" href="${home}">Back to sign in</a>
    <noscript><p>Enable JavaScript to reset your password.</p></noscript>
  </div></main>
  <script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}

const SCRIPT = String.raw`
(() => {
  const requestForm = document.querySelector('#request-form');
  const resetForm = document.querySelector('#reset-form');
  const status = document.querySelector('#status');
  const error = document.querySelector('#error');
  let token = ''; let pending = false; let done = false;
  function readLink() {
    const incoming = new URLSearchParams(location.hash.slice(1)).get('token');
    if (location.hash) history.replaceState(null, '', location.pathname);
    if (!incoming) return;
    token = incoming; done = false;
    status.textContent = ''; error.textContent = '';
    document.querySelector('#another').hidden = true;
    for (const field of resetForm.querySelectorAll('input')) {field.value = ''; field.readOnly = false;}
    const button = resetForm.querySelector('button');
    button.textContent = 'Save new password'; button.removeAttribute('aria-disabled');
    requestForm.hidden = true; resetForm.hidden = false;
    document.querySelector('#title').textContent = 'Choose a new password';
    document.querySelector('#intro').textContent = 'Your new password works here and on NixAmp. Existing sessions will be signed out.';
  }
  readLink(); window.addEventListener('hashchange', readLink);
  async function submit(form, path, input) {
    if (pending || done) return;
    pending = true; error.textContent = ''; status.textContent = '';
    const button = form.querySelector('button');
    button.setAttribute('aria-disabled', 'true'); form.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(path, {method:'POST', credentials:'same-origin', headers:{'content-type':'application/json'}, body:JSON.stringify(input)});
      const result = await response.json();
      if (!response.ok) {
        if (form === resetForm && response.status === 400) document.querySelector('#another').hidden = false;
        throw new Error(result.error || 'That did not work. Please try again.');
      }
      status.textContent = result.message;
      if (form === resetForm) {
        done = true; token = '';
        for (const field of form.querySelectorAll('input')) {field.value = ''; field.readOnly = true;}
        button.textContent = 'Password saved';
        document.querySelector('#back').textContent = 'Sign in with your new password';
      }
    } catch (problem) {error.textContent = problem instanceof TypeError ? 'Could not connect. Please try again.' : problem.message;}
    finally {pending = false; form.removeAttribute('aria-busy'); if (!done) button.removeAttribute('aria-disabled');}
  }
  requestForm.addEventListener('submit', event => {
    event.preventDefault();
    void submit(requestForm, '/api/v1/auth/password-reset/request', {email:requestForm.elements.email.value.trim()});
  });
  resetForm.addEventListener('submit', event => {
    event.preventDefault();
    if (pending || done) return;
    const password = resetForm.elements.password.value;
    if (password !== resetForm.elements.confirm.value) {error.textContent = 'The passwords do not match.'; return;}
    if (!/[0-9]/.test(password)) {error.textContent = 'Include at least one number in your password.'; return;}
    void submit(resetForm, '/api/v1/auth/password-reset/confirm', {token, password});
  });
})();`;

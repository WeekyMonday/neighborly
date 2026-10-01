(() => {
  const transitionKey = 'neighborly_login_transition';
  try {
    if (sessionStorage.getItem(transitionKey) !== '1') return;
    sessionStorage.removeItem(transitionKey);
  } catch (error) {
    return;
  }

  if (document.getElementById('neighborly-loading-screen')) return;

  const loader = document.createElement('div');
  loader.id = 'neighborly-loading-screen';
  loader.setAttribute('role', 'status');
  loader.setAttribute('aria-live', 'polite');
  loader.setAttribute('aria-label', 'Loading Neighborly');
  loader.innerHTML = `
    <div class="neighborly-loader-brand">
      <span class="neighborly-loader-mark" aria-hidden="true">
        <svg viewBox="0 0 128 128" fill="none">
          <defs>
            <linearGradient id="neighborly-silk" x1="12" y1="20" x2="116" y2="108" gradientUnits="userSpaceOnUse"><stop stop-color="#ffffff" stop-opacity=".08"/><stop offset=".48" stop-color="#f3a17a"/><stop offset="1" stop-color="#ffffff" stop-opacity=".12"/></linearGradient>
          </defs>
          <g class="neighborly-loader-silk neighborly-loader-silk-a">
            <path d="M64 9c23 0 50 18 54 43 4 24-20 57-45 65-26 8-59-8-65-32C2 60 22 25 46 13c6-3 12-4 18-4Z" stroke="url(#neighborly-silk)" stroke-width="1.2"/>
            <path d="M14 58c8-23 31-39 55-38 24 1 45 18 47 39 2 22-21 49-44 54-23 5-49-9-57-30-3-8-4-17-1-25Z" stroke="url(#neighborly-silk)" stroke-width=".7"/>
          </g>
          <g class="neighborly-loader-silk neighborly-loader-silk-b">
            <path d="M64 12c-21 2-43 20-48 41-5 21 7 49 27 61 19 12 52 3 67-15 15-17 14-47-2-66C96 18 79 10 64 12Z" stroke="url(#neighborly-silk)" stroke-width=".8"/>
          </g>
          <g class="neighborly-loader-logo">
            <path d="m30 39 36-20v38H30V39Z" fill="#fff"/>
            <path d="M70 32h28v25H70z" fill="#fff"/>
            <path d="M30 63h36v27H30z" fill="#fff"/>
            <path d="M70 63h28v27H70z" fill="#fff"/>
          </g>
        </svg>
      </span>
      <span class="neighborly-loader-name">Neighborly</span>
      <span class="neighborly-loader-caption">Your community is coming into view</span>
      <span class="neighborly-loader-track" aria-hidden="true"><span></span></span>
    </div>`;
  document.body.appendChild(loader);

  const startedAt = performance.now();
  let dismissed = false;
  function dismissLoader() {
    if (dismissed) return;
    dismissed = true;
    const remaining = Math.max(0, 850 - (performance.now() - startedAt));
    window.setTimeout(() => {
      loader.classList.add('is-leaving');
      window.setTimeout(() => loader.remove(), 420);
    }, remaining);
  }

  if (document.readyState === 'complete') dismissLoader();
  else window.addEventListener('load', dismissLoader, { once: true });
  window.setTimeout(dismissLoader, 10000);
})();

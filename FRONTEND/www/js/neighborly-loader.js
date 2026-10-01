(() => {
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
            <linearGradient id="neighborly-logo-green" x1="14" y1="16" x2="73" y2="69" gradientUnits="userSpaceOnUse"><stop stop-color="#58F28A"/><stop offset="1" stop-color="#16D89A"/></linearGradient>
            <linearGradient id="neighborly-logo-yellow" x1="81" y1="42" x2="112" y2="70" gradientUnits="userSpaceOnUse"><stop stop-color="#FFE467"/><stop offset="1" stop-color="#FFAF50"/></linearGradient>
            <linearGradient id="neighborly-logo-blue" x1="43" y1="77" x2="72" y2="109" gradientUnits="userSpaceOnUse"><stop stop-color="#678BFF"/><stop offset="1" stop-color="#8B69F5"/></linearGradient>
            <linearGradient id="neighborly-logo-pink" x1="81" y1="77" x2="112" y2="109" gradientUnits="userSpaceOnUse"><stop stop-color="#FF7D84"/><stop offset="1" stop-color="#F35AB2"/></linearGradient>
          </defs>
          <path d="M22 45 64 22v42H22V45Z" fill="url(#neighborly-logo-green)"/>
          <path d="M67 45h22v19H67z" fill="url(#neighborly-logo-yellow)"/>
          <path d="M41 67h23v22H41z" fill="url(#neighborly-logo-blue)"/>
          <path d="M67 67h22v22H67z" fill="url(#neighborly-logo-pink)"/>
        </svg>
      </span>
      <span class="neighborly-loader-name">Neighborly</span>
      <span class="neighborly-loader-caption">Your community, loading in</span>
      <span class="neighborly-loader-track" aria-hidden="true"><span></span></span>
    </div>`;
  document.body.appendChild(loader);

  const startedAt = performance.now();
  let dismissed = false;
  function dismissLoader() {
    if (dismissed) return;
    dismissed = true;
    const remaining = Math.max(0, 650 - (performance.now() - startedAt));
    window.setTimeout(() => {
      loader.classList.add('is-leaving');
      window.setTimeout(() => loader.remove(), 420);
    }, remaining);
  }

  if (document.readyState === 'complete') dismissLoader();
  else window.addEventListener('load', dismissLoader, { once: true });
  window.setTimeout(dismissLoader, 6000);
})();

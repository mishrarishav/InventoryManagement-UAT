/* Static Pages UI. Authentication and all inventory data come from the configured IIS API. */
(() => {
  'use strict';
  const base = window.INVENTORY_UAT_BASE;
  const api = window.INVENTORY_API_BASE.replace(/\/$/, '');
  const nativeFetch = window.fetch.bind(window);
  const authKey = `inventory-pages:${base}:server-login:v1`;
  const isLogin = /\/Users\/Login\/?$/i.test(location.pathname);
  const isDashboard = /\/Report\/Dashboard\/?$/i.test(location.pathname);
  let auth;
  try { auth = JSON.parse(localStorage.getItem(authKey)); } catch { auth = null; }

  function logout() {
    localStorage.removeItem(authKey);
    auth = null;
    location.assign(`${base}Users/Login/`);
  }

  async function send(route, options = {}, anonymous = false) {
    const headers = { Accept: 'application/json' };
    if (!anonymous && auth?.token) headers.Authorization = `Bearer ${auth.token}`;
    if (options.body != null) headers['Content-Type'] = 'application/json';
    let response;
    try {
      response = await nativeFetch(api + route, {
        method: options.method || 'GET', headers, credentials: 'omit',
        ...(options.body != null ? { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) } : {})
      });
    } catch { throw new Error('Could not reach the server. Please try again.'); }
    const text = await response.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!response.ok) {
      if (response.status === 401 && !anonymous && !isLogin) logout();
      throw Object.assign(new Error(data?.message || (typeof data === 'string' && data.length < 500 ? data : 'The server could not complete this request.')),
        { status: response.status });
    }
    return data;
  }

  const ready = Promise.resolve();
  if (!isLogin) {
    if (!auth?.token) logout();
  }

  // The API validates every token. Avoid blocking every page on a second login
  // check, and start dashboard data while the HTML/styles/scripts are loading.
  const eager = new Map();
  if (isDashboard && auth?.token) {
    for (const route of ['/api/dashboard', '/Report/MaterialInwardReportDashboard', '/Report/MaterialOutwardReportDashboard']) {
      const pending = send(route);
      pending.catch(() => {});
      eager.set(route, pending);
    }
  }
  const inFlight = new Map();

  function apiRoute(input) {
    const url = new URL(input, location.href);
    if (url.origin !== location.origin && url.origin !== new URL(api).origin) return null;
    let route = url.pathname;
    if (route.startsWith(base)) route = '/' + route.slice(base.length);
    const backendPrefix = new URL(api).pathname.replace(/\/$/, '');
    if (backendPrefix && route.startsWith(backendPrefix + '/')) route = route.slice(backendPrefix.length);
    if (/^\/api\//i.test(route) || /^\/(Users|RackMaster|LevelMaster|BinMaster|LocationMaster|MaterialType|Material|MaterialMapping|MaterialMovement|Report)\/(Get\w*|Create\w*|Edit|ChangePassword|Material\w*Report\w*|LowStockReport|InwardReport|OutwardReport)$/i.test(route))
      return route + url.search;
    return null;
  }

  async function request(input, options = {}) {
    await ready;
    const route = apiRoute(input);
    if (!route) throw new Error('Unknown inventory API route.');
    if ((options.method || 'GET').toUpperCase() !== 'GET') return send(route, options);
    if (eager.has(route)) {
      const pending = eager.get(route);
      eager.delete(route);
      return pending;
    }
    if (!inFlight.has(route)) {
      const pending = send(route, options).finally(() => inFlight.delete(route));
      inFlight.set(route, pending);
    }
    return inFlight.get(route);
  }

  function installJQuery($) {
    $.ajaxTransport('+*', options => {
      if (!apiRoute(options.url)) return undefined;
      let cancelled = false;
      return {
        send(_, complete) {
          request(options.url, { method: options.type, body: options.data }).then(
            data => { if (!cancelled) complete(200, 'success', { text: JSON.stringify(data) }, 'Content-Type: application/json'); },
            error => { if (!cancelled) complete(error.status || 503, 'error', { text: error.message }); }
          );
        },
        abort() { cancelled = true; }
      };
    });
  }

  window.fetch = async (input, options) => {
    if (typeof input !== 'string' || !apiRoute(input)) return nativeFetch(input, options);
    try { return new Response(JSON.stringify(await request(input, options)), { headers: { 'Content-Type': 'application/json' } }); }
    catch (error) { return new Response(error.message, { status: error.status || 503 }); }
  };
  window.InventoryUat = { request, installJQuery, ready };

  function mountBrandFooter() {
    if (document.getElementById('globalBrandFooter')) return;
    document.body.classList.add('global-brand-footer-enabled');
    const footer = document.createElement('div');
    footer.id = 'globalBrandFooter';
    footer.className = 'global-brand-footer';
    footer.innerHTML = '<span class="global-brand-footer-text"><span class="global-brand-footer-owner">by <strong>Mahad Globus India</strong></span></span>'
      + `<img src="${base}assets/img/mahad-globus.png" alt="" width="24" height="24">`;
    const particles = document.createElement('span');
    particles.className = 'global-brand-footer-particles';
    particles.setAttribute('aria-hidden', 'true');
    // Independent CSS axes reproduce the reference's floating glitter dots.
    for (let index = 0; index < 48; index++) {
      const horizontal = document.createElement('span');
      horizontal.className = 'global-brand-footer-particle-x';
      const vertical = document.createElement('span');
      vertical.className = 'global-brand-footer-particle-y';
      const durationX = 12 + Math.random() * 12;
      const durationY = 3 + Math.random() * 5;
      horizontal.style.setProperty('--footer-dot-size', `${(1.3 + Math.random() * 1.1).toFixed(2)}px`);
      horizontal.style.setProperty('--footer-dot-opacity', (0.45 + Math.random() * 0.4).toFixed(2));
      horizontal.style.setProperty('--footer-bounce-x', `${durationX.toFixed(2)}s`);
      horizontal.style.setProperty('--footer-bounce-y', `${durationY.toFixed(2)}s`);
      horizontal.style.setProperty('--footer-delay-x', `${(-Math.random() * durationX * 2).toFixed(2)}s`);
      horizontal.style.setProperty('--footer-delay-y', `${(-Math.random() * durationY * 2).toFixed(2)}s`);
      horizontal.appendChild(vertical);
      particles.appendChild(horizontal);
    }
    footer.appendChild(particles);
    document.body.appendChild(footer);
  }

  function status(text, error = false) {
    let element = document.getElementById('uat-status');
    if (!element) {
      element = document.createElement('div');
      element.id = 'uat-status';
      element.setAttribute('role', 'status');
      (document.getElementById('inventory-login-feedback') || document.body).append(element);
    }
    element.textContent = text;
    element.style.background = error ? '#fee2e2' : '#eef2ff';
  }

  async function hydrate() {
    if (isLogin) { status('Enter your username and password to continue.'); return; }
    await ready;
    const profile = document.querySelector('.nav-profile span');
    if (profile) profile.textContent = auth.user.name;
    const role = document.querySelector('.dropdown-header span');
    if (role) role.textContent = auth.user.role;
    // Forms with MVC-rendered choices must use current server records after export.
    const needsChoices = /\/(?:Report|MaterialMapping)\//i.test(location.pathname)
      && document.querySelector('#materialDescription, #materialBarcode, #materialId, #supplierId, #customerId');
    if (needsChoices) {
      const [materials, suppliers, customers, racks] = await Promise.all([
        request('/Material/GetAll'),
        document.getElementById('supplierId') ? request('/LocationMaster/GetSuppliers') : null,
        document.getElementById('customerId') ? request('/LocationMaster/GetIssueTo') : null,
        /\/MaterialMapping\//i.test(location.pathname) ? request('/RackMaster/GetAll') : null
      ]);
      const fill = (id, rows, value, label) => {
        const select = document.getElementById(id);
        if (!select || select.tagName !== 'SELECT') return;
        const first = select.options[0]?.text || 'Select';
        select.replaceChildren(new Option(first, ''), ...rows.map(row => new Option(row[label] ?? '', row[value])));
      };
      fill('materialDescription', materials, 'materialId', 'materialName');
      fill('materialBarcode', materials, 'materialId', 'barCode');
      if (/\/Report\//i.test(location.pathname)) fill('materialId', materials, 'materialId', 'materialName');
      if (suppliers) fill('supplierId', suppliers, 'locationId', 'locationName');
      if (customers) fill('customerId', customers, 'locationId', 'locationName');
      if (racks) fill('rack', racks, 'rackId', 'rackNumber');
    }
    if (/\/Report\/Dashboard\/?$/i.test(location.pathname)) {
      const data = await request('/api/dashboard');
      document.getElementById('genValue').textContent = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(data.inventoryValue ?? 0);
      document.getElementById('InValue').textContent = data.inventoryCount ?? 0;
      const values = document.querySelectorAll('#PenValue');
      values[0].textContent = data.lowStockCount;
      values[1].textContent = `${Number(data.capacityUtilization || 0).toFixed(1)} %`;
    }
    status('Inventory UAT · Connected to the shared server database.');
  }

  document.addEventListener('DOMContentLoaded', () => {
    mountBrandFooter();
    status(isLogin ? 'Enter your username and password to continue.' : 'Connecting to the server…');
    hydrate().catch(error => status(error.message, true));
    if (isLogin) {
      document.querySelector('form.login').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button[type="submit"]');
        button.disabled = true;
        status('Signing in…');
        try {
          auth = await send('/api/auth/login', { method: 'POST', body: {
            username: document.getElementById('username').value, password: document.getElementById('password').value
          } }, true);
          localStorage.setItem(authKey, JSON.stringify(auth));
          location.assign(`${base}Report/Dashboard/`);
        } catch (error) { status(error.message, true); button.disabled = false; }
      });
    }
    document.querySelectorAll('a[href="#uat-logout"]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); logout(); }));
  });
})();

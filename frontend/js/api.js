'use strict';
/** Client API : jeton d'accès en sessionStorage (effacé à la fermeture de l'onglet) ; le refresh token vit dans un cookie HttpOnly (illisible par le JavaScript). Refresh automatique sur 401. */
const Api = (() => {
  const store = {
    get access() { return sessionStorage.getItem('pmp_access'); },
    set(a) { sessionStorage.setItem('pmp_access', a); },
    clear() { sessionStorage.removeItem('pmp_site'); sessionStorage.removeItem('pmp_access'); sessionStorage.removeItem('pmp_refresh'); /* pmp_refresh : reliquat des versions < 0.6.2 */ },
  };
  // Pharmacie de travail de l'Admin d'une pharmacie multi-sites (en-tête X-Pharmacy-Id) ; absente = sa propre pharmacie
  const siteStore = { get id() { return sessionStorage.getItem('pmp_site'); }, set(id) { if (id) sessionStorage.setItem('pmp_site', id); else sessionStorage.removeItem('pmp_site'); } };
  let onLogout = () => {};
  let refreshing = null;

  async function raw(method, url, body, auth = true, site) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth && store.access) headers.Authorization = `Bearer ${store.access}`;
    const siteId = site === undefined ? siteStore.id : site;     // site : pharmacie imposée pour cet appel (null = la sienne)
    if (auth && siteId && !url.startsWith('/api/groupe')) headers['X-Pharmacy-Id'] = siteId;
    let res;
    try { res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch { const e = new Error('Connexion impossible : vérifiez votre réseau.'); e.status = 0; throw e; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `Erreur ${res.status}`); e.status = res.status; e.code = data.code; e.alerts = data.alerts; e.requiresNote = data.requiresNote; throw e; }
    return data;
  }

  async function refreshTokens() {
    refreshing = refreshing || raw('POST', '/api/auth/refresh', {}, false)   // le cookie HttpOnly part tout seul (même origine)
      .then((d) => { store.set(d.accessToken); })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  async function call(method, url, body, site) {
    try { return await raw(method, url, body, true, site); } catch (e) {
      if (e.status === 401 && e.code === 'TOKEN_INVALID') {
        try { await refreshTokens(); return await raw(method, url, body, true, site); } catch { store.clear(); onLogout(); throw e; }
      }
      throw e;
    }
  }

  /** Téléchargement authentifié (export CSV) : le jeton passe par l'en-tête, jamais dans l'URL. */
  async function download(url, filename) {
    const go = () => fetch(url, { headers: { Authorization: `Bearer ${store.access}`, ...(siteStore.id ? { 'X-Pharmacy-Id': siteStore.id } : {}) } });
    let res = await go();
    if (res.status === 401) { await refreshTokens(); res = await go(); }
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Erreur ${res.status}`); }
    const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = filename;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return {
    download,
    get: (u) => call('GET', u), post: (u, b) => call('POST', u, b ?? {}), put: (u, b) => call('PUT', u, b), del: (u) => call('DELETE', u), patch: (u, b) => call('PATCH', u, b),
    setSite: siteStore.set, getSite: () => siteStore.id,
    as: (site) => ({ get: (u) => call('GET', u, undefined, site), post: (u, b) => call('POST', u, b ?? {}, site) }),   // appel dans UNE pharmacie précise (ex. désigner un gérant)
    postPublic: (u, b) => raw('POST', u, b, false),
    setTokens: store.set, clear: store.clear, hasSession: () => !!store.access,
    logout: async () => { try { await raw('POST', '/api/auth/logout', {}, false); } catch { /* ignore */ } store.clear(); },
    onLogout: (fn) => { onLogout = fn; },
  };
})();

export function OperatorLogin() {
  return <main className="login-shell"><section className="login-panel" aria-labelledby="login-title">
    <p className="product-name">f(AI) Studio</p><p className="eyebrow">Доступ оператора</p><h1 id="login-title">Control Panel</h1>
    <p>Войдите через разрешённую учётную запись GitHub.</p>
    {/* OAuth starts with a server redirect rather than a client-side page transition. */}
    {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
    <a className="login-action" href="/api/auth/github/login">Войти через GitHub</a>
  </section></main>;
}

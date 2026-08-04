export function OperatorLogin() {
  return <main className="login-shell"><section className="login-panel" aria-labelledby="login-title">
    <p className="product-name">f(AI) Studio</p><p className="eyebrow">Operator access</p><h1 id="login-title">Control Plane</h1>
    <p>Sign in with an authorized GitHub operator account.</p>
    {/* OAuth starts with a server redirect rather than a client-side page transition. */}
    {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
    <a className="login-action" href="/api/auth/github/login">Continue with GitHub</a>
  </section></main>;
}

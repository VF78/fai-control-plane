export default function Loading() {
  return <main className="fcp-workspace" aria-busy="true" aria-live="polite">
    <div className="fcp-main"><section className="fcp-blank"><div><h2>Loading workspace facts</h2><p>Reading the configured control-plane records.</p></div></section></div>
  </main>;
}

import Link from "next/link";

// Missing vault file → a real 404 (notFound() from the page). The path
// is gone from disk — moved, renamed, or never was; the vault's commit
// history is the truth of where it went.
export default function VaultNotFound() {
  return (
    <div className="vault-page">
      <header className="vault-head">
        <Link className="vault-back" href="/cockpit/honey">
          ← cockpit
        </Link>
        <span className="vault-path">/vault</span>
        <span className="vault-mode">read-only · vault mirror</span>
      </header>
      <main className="vault-body">
        <div className="vault-error" role="alert">
          <b>404 — file not found in the vault</b>
          <p>
            The link points at a path that isn&apos;t on disk. Ask Honey where it
            went — the vault commit history knows.
          </p>
        </div>
      </main>
    </div>
  );
}

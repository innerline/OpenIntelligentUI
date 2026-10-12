import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { readVaultFile } from "@/lib/vault-file";
import { VaultDoc } from "./vault-doc";
import "./vault.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Vault · cockpit",
  description:
    "Read-only vault file viewer — the cockpit's own door. Keyless: the tailnet is the boundary.",
};

// /vault — the cockpit's own read-only vault viewer (owner 2026-10-12:
// "are we running two systems side by side?" — no more borrowing the
// old keyed door). Server-reads the MWP vault and renders the note with
// the same markdown pipeline the chat answers use. Old-world keyed
// links (?t=<token>) are tolerated: the token is simply not read.
// Path safety is the receipt route's proven validation (lib/vault-file):
// traversal blocked, missing → 404, anything but notes/canvases refused.

export default async function VaultPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const raw = params.file;
  const file = Array.isArray(raw) ? raw[0] : raw; // duplicate ?file= — first wins
  const result = readVaultFile(file);

  if (!result.ok) {
    if (result.status === 404) notFound();
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
            <b>
              {result.status} — {result.message}
            </b>
            {file ? <code>{file}</code> : null}
            <p>
              Vault notes and canvases open here, read-only — ask Honey to file or
              change one. Editing stays in the vault, where the file is the truth.
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="vault-page">
      <header className="vault-head">
        <Link className="vault-back" href="/cockpit/honey">
          ← cockpit
        </Link>
        <span className="vault-path" title={file}>
          {file}
        </span>
        <span className="vault-mode">read-only · vault mirror</span>
      </header>
      <main className="vault-body">
        <VaultDoc content={result.content} canvas={/\.canvas$/i.test(result.abs)} />
      </main>
    </div>
  );
}

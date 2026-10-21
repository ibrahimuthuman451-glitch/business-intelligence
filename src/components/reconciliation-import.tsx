"use client";

import { useState } from "react";
import { runReconciliationAction } from "@/app/app/actions";

type Preview = {
  headers: string[];
  format: string;
  rows: number;
  suggestion: { invoiceNumber?: string; amount?: string; date?: string };
};

export function ReconciliationImport() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [source, setSource] = useState("ebm_sales");
  const [mapping, setMapping] = useState({ invoiceNumber: "", amount: "", date: "" });
  const [hasFile, setHasFile] = useState(false);

  async function inspect(selected: File | null) {
    setPreview(null);
    setError(null);
    setHasFile(Boolean(selected));
    setMapping({ invoiceNumber: "", amount: "", date: "" });
    if (!selected) return;
    setLoading(true);
    try {
      const body = new FormData();
      body.append("file", selected);
      const response = await fetch("/api/reconciliation/preview", { method: "POST", body });
      const data = (await response.json()) as Preview & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Could not read the file");
      setPreview(data);
      setMapping({
        invoiceNumber: data.suggestion.invoiceNumber ?? "",
        amount: data.suggestion.amount ?? "",
        date: data.suggestion.date ?? "",
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read the file");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card section">
      <div className="card-head"><h2>Import a file</h2><span className="tiny muted">CSV or XLSX · mapping confirmed before import</span></div>
      <div className="card-pad">
        <div className="alert info small">
          This is a file import, not a live EBM or RRA connection. Export the report yourself and upload it.
          Never enter a government portal password here.
        </div>
        {error ? <div className="alert error">{error}</div> : null}
        <form action={runReconciliationAction} encType="multipart/form-data">
          <input type="hidden" name="returnTo" value="/app/reconciliation" />
          <input type="hidden" name="source" value={source} />
          <input type="hidden" name="mapping" value={JSON.stringify(mapping)} />
          <div className="form-grid">
            <div className="field">
              <label htmlFor="recon-file">Report file</label>
              <input
                id="recon-file"
                name="file"
                type="file"
                accept=".csv,.xlsx"
                required
                onChange={(event) => void inspect(event.target.files?.[0] ?? null)}
              />
            </div>
            <div className="field">
              <label htmlFor="recon-source">Report type</label>
              <select id="recon-source" value={source} onChange={(event) => setSource(event.target.value)}>
                <option value="ebm_sales">Sales report</option>
                <option value="ebm_purchases">Purchases report</option>
              </select>
            </div>
          </div>
          {loading ? <p className="small muted">Reading headers…</p> : null}
          {preview ? (
            <>
              <p className="small"><strong>{preview.rows}</strong> data rows · {preview.format.toUpperCase()}</p>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="map-invoice">Invoice / reference column *</label>
                  <select
                    id="map-invoice"
                    value={mapping.invoiceNumber}
                    onChange={(event) => setMapping({ ...mapping, invoiceNumber: event.target.value })}
                    required
                  >
                    <option value="" disabled>Select column</option>
                    {preview.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="map-amount">Amount column *</label>
                  <select
                    id="map-amount"
                    value={mapping.amount}
                    onChange={(event) => setMapping({ ...mapping, amount: event.target.value })}
                    required
                  >
                    <option value="" disabled>Select column</option>
                    {preview.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="map-date">Date column (optional)</label>
                  <select
                    id="map-date"
                    value={mapping.date}
                    onChange={(event) => setMapping({ ...mapping, date: event.target.value })}
                  >
                    <option value="">No date column</option>
                    {preview.headers.map((header) => <option key={header} value={header}>{header}</option>)}
                  </select>
                </div>
              </div>
              <p className="tiny muted">Findings are stored with the raw row for human review. Matching is by invoice number and amount.</p>
            </>
          ) : null}
          <button className="btn accent" type="submit" disabled={!hasFile || !preview}>
            Run reconciliation
          </button>
        </form>
      </div>
    </div>
  );
}

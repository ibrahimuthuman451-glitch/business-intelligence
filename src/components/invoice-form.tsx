"use client";

import { useMemo, useState } from "react";
import { createInvoiceAction } from "@/app/app/actions";

type Customer = { id: string; name: string };
type Line = { description: string; quantity: string; unitPrice: string; taxRatePercent: string };

const emptyLine = (): Line => ({ description: "", quantity: "1", unitPrice: "", taxRatePercent: "0" });

export function InvoiceForm({ customers, currency }: { customers: Customer[]; currency: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const [lines, setLines] = useState<Line[]>([emptyLine()]);

  const totals = useMemo(() => {
    return lines.reduce(
      (acc, line) => {
        const qty = Number(line.quantity) || 0;
        const price = Number(String(line.unitPrice).replace(/,/g, "")) || 0;
        const subtotal = Math.round(qty * price);
        const tax = Math.round((subtotal * (Number(line.taxRatePercent) || 0)) / 100);
        return { subtotal: acc.subtotal + subtotal, tax: acc.tax + tax };
      },
      { subtotal: 0, tax: 0 },
    );
  }, [lines]);

  function update(index: number, patch: Partial<Line>) {
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  return (
    <form action={createInvoiceAction}>
      <input type="hidden" name="returnTo" value="/app/invoices" />
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      <div className="form-grid">
        <div className="field">
          <label htmlFor="number">Invoice number (optional)</label>
          <input id="number" name="number" placeholder="Generated automatically" />
        </div>
        <div className="field">
          <label htmlFor="customerId">Customer</label>
          <select id="customerId" name="customerId" defaultValue="">
            <option value="">No customer</option>
            {customers.map((customer) => (
              <option key={customer.id} value={customer.id}>{customer.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="issueDate">Issue date</label>
          <input id="issueDate" name="issueDate" type="date" required defaultValue={today} />
        </div>
        <div className="field">
          <label htmlFor="dueDate">Due date</label>
          <input id="dueDate" name="dueDate" type="date" required defaultValue={today} />
        </div>
        <div className="field">
          <label htmlFor="status">Create as</label>
          <select id="status" name="status" defaultValue="sent">
            <option value="sent">Issued</option>
            <option value="draft">Draft</option>
          </select>
        </div>
      </div>

      <h3 className="mt-2">Line items</h3>
      <div className="stack-tight">
        {lines.map((line, index) => (
          <div key={index} className="grid" style={{ gridTemplateColumns: "minmax(200px, 1fr) 90px 130px 90px auto", alignItems: "end" }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Description</label>
              <input value={line.description} onChange={(event) => update(index, { description: event.target.value })} required />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Qty</label>
              <input type="number" min={1} value={line.quantity} onChange={(event) => update(index, { quantity: event.target.value })} required />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Unit price ({currency})</label>
              <input inputMode="decimal" value={line.unitPrice} onChange={(event) => update(index, { unitPrice: event.target.value })} required />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Tax %</label>
              <input type="number" min={0} max={100} value={line.taxRatePercent} onChange={(event) => update(index, { taxRatePercent: event.target.value })} />
            </div>
            <button type="button" className="btn secondary small" onClick={() => setLines((current) => current.filter((_, i) => i !== index))} disabled={lines.length === 1}>
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="row mt-2">
        <button type="button" className="btn secondary small" onClick={() => setLines((current) => [...current, emptyLine()])}>Add line</button>
        <span className="small muted">Preview subtotal {totals.subtotal.toLocaleString()} {currency} · tax {totals.tax.toLocaleString()} {currency}</span>
      </div>
      <div className="field mt-2">
        <label htmlFor="notes">Notes (optional)</label>
        <textarea id="notes" name="notes" placeholder="Payment terms or references" />
      </div>
      <button className="btn accent" type="submit">Create invoice</button>
    </form>
  );
}

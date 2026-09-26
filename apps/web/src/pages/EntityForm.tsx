import { useState } from 'react';
import { ErrorBox } from './common';

// Formulaire générique décrit par une liste de champs. Les montants sont
// saisis en unités (ex. MAD) et convertis en unités mineures (centimes).

export type FieldType = 'text' | 'number' | 'time' | 'date' | 'select' | 'checkbox' | 'weekdays' | 'money' | 'holes';

export interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: Array<[string, string]>; // [valeur, libellé] ; '' = vide (null)
  nullable?: boolean; // champ vide → null
  hint?: string;
  createOnly?: boolean;
}

const DAYS: Array<[number, string]> = [[1, 'L'], [2, 'M'], [3, 'M'], [4, 'J'], [5, 'V'], [6, 'S'], [7, 'D']];

function toForm(f: Field, v: unknown): unknown {
  if (f.type === 'money') return v === null || v === undefined ? '' : String(Number(v) / 100);
  if (f.type === 'number') return v === null || v === undefined ? '' : String(v);
  if (f.type === 'select') return v === null || v === undefined ? '' : String(v);
  if (f.type === 'checkbox') return !!v;
  if (f.type === 'weekdays' || f.type === 'holes') return (v as number[] | null) ?? [];
  return (v as string | null) ?? '';
}

function fromForm(f: Field, v: unknown): unknown {
  if (f.type === 'money') return v === '' ? null : Math.round(Number(String(v).replace(',', '.')) * 100);
  if (f.type === 'number') return v === '' ? null : Number(v);
  if (f.type === 'checkbox') return !!v;
  if (f.type === 'weekdays' || f.type === 'holes') return (v as number[]).length ? [...(v as number[])].sort((a, b) => a - b) : null;
  if (f.type === 'select') {
    if (v === '') return null;
    return /^\d+$/.test(String(v)) && f.options?.every(([o]) => o === '' || /^\d+$/.test(o)) ? Number(v) : v;
  }
  return v === '' && f.nullable !== false ? null : v;
}

export function EntityForm({ fields, initial, isNew, onSubmit, onCancel, submitLabel }: {
  fields: Field[];
  initial: Record<string, unknown>;
  isNew: boolean;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const visible = fields.filter((f) => isNew || !f.createOnly);
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(visible.map((f) => [f.key, toForm(f, initial[f.key])])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setValues((s) => ({ ...s, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(Object.fromEntries(visible.map((f) => [f.key, fromForm(f, values[f.key])])));
    } catch (err) {
      const e2 = err as Error & { details?: { issues?: Array<{ path: string[]; message: string }> } };
      const issue = e2.details?.issues?.[0];
      setError(issue ? `${visible.find((f) => f.key === issue.path[0])?.label ?? issue.path.join('.')} : ${issue.message}` : e2.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="grid2">
        {visible.map((f) => {
          const v = values[f.key];
          if (f.type === 'checkbox') {
            return <label key={f.key} className="check"><input type="checkbox" checked={!!v} onChange={(e) => set(f.key, e.target.checked)} /> {f.label}</label>;
          }
          if (f.type === 'weekdays' || f.type === 'holes') {
            const list = v as number[];
            const choices: Array<[number, string]> = f.type === 'holes' ? [[9, '9 trous'], [18, '18 trous']] : DAYS;
            return (
              <label key={f.key}>{f.label}
                <span className="row" style={{ gap: 6 }}>
                  {choices.map(([n, l]) => (
                    <label key={n} className="check" style={{ gap: 3 }}>
                      <input type="checkbox" checked={list.includes(n)}
                        onChange={(e) => set(f.key, e.target.checked ? [...list, n] : list.filter((x) => x !== n))} />{l}
                    </label>
                  ))}
                </span>
                {f.hint && <span className="small muted">{f.hint}</span>}
              </label>
            );
          }
          if (f.type === 'select') {
            return (
              <label key={f.key}>{f.label}
                <select value={String(v)} onChange={(e) => set(f.key, e.target.value)}>
                  {f.options!.map(([o, l]) => <option key={o} value={o}>{l}</option>)}
                </select>
              </label>
            );
          }
          return (
            <label key={f.key}>{f.label}
              <input
                type={f.type === 'money' || f.type === 'number' ? 'text' : f.type}
                inputMode={f.type === 'money' || f.type === 'number' ? 'decimal' : undefined}
                value={String(v)} onChange={(e) => set(f.key, e.target.value)} />
              {f.hint && <span className="small muted">{f.hint}</span>}
            </label>
          );
        })}
      </div>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy}>{submitLabel ?? (isNew ? 'Ajouter' : 'Enregistrer')}</button>
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Annuler</button>}
      </div>
    </form>
  );
}

export function weekdaysLabel(days: number[] | null): string {
  if (!days || days.length === 0 || days.length === 7) return 'tous les jours';
  const names = ['', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
  return days.map((d) => names[d]).join(', ');
}

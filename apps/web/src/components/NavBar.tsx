// Barre de menu modulable : chacun choisit et ordonne ses onglets ; les autres
// restent dans le menu « Plus ▾ ». Préférence enregistrée sur le compte.

import { useEffect, useRef, useState } from 'react';
import { put } from '../api';
import { useI18n } from '../i18n';

export interface NavItem { id: string; label: string }
export const DEFAULT_PINNED = 5;

export function pinnedItems(items: NavItem[], saved: string[] | undefined): NavItem[] {
  if (!saved?.length) return items.slice(0, DEFAULT_PINNED);
  const byId = new Map(items.map((i) => [i.id, i]));
  return saved.map((id) => byId.get(id)).filter((i): i is NavItem => !!i);
}

export function NavBar({ items, active, saved, onSelect, onSaved, canSave }: {
  items: NavItem[]; active: string; saved: string[] | undefined; onSelect: (id: string) => void;
  onSaved: (pinned: string[]) => void; canSave: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pinned = pinnedItems(items, saved);
  const others = items.filter((i) => !pinned.includes(i));
  const activeOther = others.find((i) => i.id === active);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);

  return (
    <nav className="nav" aria-label="Menu">
      {pinned.map((i) => (
        <button key={i.id} className={active === i.id ? 'active' : ''} aria-current={active === i.id ? 'page' : undefined} onClick={() => onSelect(i.id)}>{i.label}</button>
      ))}
      {(others.length > 0 || canSave) && (
        <div className="nav-more" ref={ref}>
          <button className={activeOther ? 'active' : ''} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
            {activeOther ? activeOther.label : t('nav.more')} ▾
          </button>
          {open && (
            <div className="menu" role="menu">
              {others.map((i) => (
                <button key={i.id} role="menuitem" className={active === i.id ? 'active' : ''} onClick={() => { onSelect(i.id); setOpen(false); }}>{i.label}</button>
              ))}
              {canSave && <>
                {others.length > 0 && <hr />}
                <button role="menuitem" onClick={() => { setEditing(true); setOpen(false); }}>⚙ {t('nav.customize')}</button>
              </>}
            </div>
          )}
        </div>
      )}
      {editing && <Customize items={items} pinned={pinned.map((i) => i.id)} onClose={() => setEditing(false)}
        onSave={async (ids) => { await put('/api/me/preferences', { navPinned: ids }); onSaved(ids); setEditing(false); }} />}
    </nav>
  );
}

function Customize({ items, pinned, onSave, onClose }: { items: NavItem[]; pinned: string[]; onSave: (ids: string[]) => Promise<void>; onClose: () => void }) {
  const { t } = useI18n();
  const byId = new Map(items.map((i) => [i.id, i]));
  const [order, setOrder] = useState<string[]>([...pinned, ...items.map((i) => i.id).filter((id) => !pinned.includes(id))]);
  const [checked, setChecked] = useState<Set<string>>(new Set(pinned));
  const [busy, setBusy] = useState(false);
  const move = (i: number, d: -1 | 1) => {
    const next = [...order];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setOrder(next);
  };
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal stack" role="dialog" aria-modal="true" aria-labelledby="nav-custom-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="nav-custom-title">{t('nav.customizeTitle')}</h2>
        <p className="small muted" style={{ margin: 0 }}>{t('nav.customizeHint')}</p>
        <ul className="orderable">
          {order.map((id, i) => (
            <li key={id}>
              <label className="check" style={{ flex: 1 }}>
                <input type="checkbox" checked={checked.has(id)} onChange={(e) => {
                  const next = new Set(checked);
                  if (e.target.checked) next.add(id); else next.delete(id);
                  setChecked(next);
                }} /> {byId.get(id)?.label}
              </label>
              <button className="btn sm icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`${t('nav.up')} ${byId.get(id)?.label}`}>↑</button>
              <button className="btn sm icon" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label={`${t('nav.down')} ${byId.get(id)?.label}`}>↓</button>
            </li>
          ))}
        </ul>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button className="btn ghost" onClick={() => { setOrder(items.map((i) => i.id)); setChecked(new Set(items.slice(0, DEFAULT_PINNED).map((i) => i.id))); }}>{t('nav.reset')}</button>
          <div className="row">
            <button className="btn" onClick={onClose}>{t('nav.cancel')}</button>
            <button className="btn primary" disabled={busy} onClick={async () => { setBusy(true); try { await onSave(order.filter((id) => checked.has(id))); } finally { setBusy(false); } }}>{t('nav.save')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

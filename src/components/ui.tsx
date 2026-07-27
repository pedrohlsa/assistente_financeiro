import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { fmtBRL, formatMoneyInput } from '../utils/format'

// ---------- Ícones (SVG minimalistas) ----------
export const Icon = {
  home: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>,
  list: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" fill="currentColor" /><circle cx="3.5" cy="12" r="1" fill="currentColor" /><circle cx="3.5" cy="18" r="1" fill="currentColor" /></svg>,
  spark: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c.4 4.9 2.3 8.6 7.5 10-5.2 1.4-7.1 5.1-7.5 10-.4-4.9-2.3-8.6-7.5-10C9.7 10.6 11.6 6.9 12 2Z" /></svg>,
  target: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4.5" /><circle cx="12" cy="12" r="0.8" fill="currentColor" /></svg>,
  more: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>,
  mic: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>,
  send: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.6 21 12 3.4 3.4l2.4 7.2L14 12l-8.2 1.4-2.4 7.2Z" /></svg>,
}

// ---------- Toast (com Desfazer — seção 32) ----------
interface ToastData { text: string; undo?: () => void }
const ToastCtx = createContext<(t: ToastData) => void>(() => {})
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastData | null>(null)
  const timer = useRef<any>(null)
  const show = useCallback((t: ToastData) => {
    setToast(t)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(null), 4500)
  }, [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button onClick={() => { toast.undo!(); setToast(null) }}>Desfazer</button>}
        </div>
      )}
    </ToastCtx.Provider>
  )
}

// ---------- Bottom Sheet ----------
export function Sheet({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: React.ReactNode; title?: string }) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog">
        <div className="sheet-handle" />
        {title && <h2 style={{ marginBottom: 14 }}>{title}</h2>}
        {children}
      </div>
    </>
  )
}

// ---------- Campo monetário ----------
/**
 * Único campo de dinheiro do app. Aceita qualquer formato tolerado por
 * `parseMoney` e só normaliza a exibição no BLUR — formatar durante a digitação
 * moveria o cursor. Valor inválido volta intacto para o usuário corrigir.
 */
export function MoneyInput({ value, onChange, className, onBlur, ...rest }: {
  value: string
  onChange: (v: string) => void
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return (
    <input
      {...rest}
      className={className || 'input'}
      inputMode="decimal"
      placeholder={rest.placeholder ?? '0,00'}
      value={value}
      onChange={e => onChange(e.target.value)}
      onBlur={e => { onChange(formatMoneyInput(e.target.value)); onBlur?.(e) }}
    />
  )
}

// ---------- Confirmação destrutiva / ambígua ----------
/**
 * Diálogo próprio da interface — não usar `window.confirm` em ação destrutiva:
 * no WebView do Android ele é bloqueado ou ignorado em parte dos aparelhos.
 */
export function ConfirmDialog({ open, title, text, actions, onClose }: {
  open: boolean
  title: string
  text?: React.ReactNode
  actions: { label: string; onClick: () => void; tone?: 'primary' | 'danger' | 'soft' }[]
  onClose: () => void
}) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onClose])
  if (!open) return null
  const cls = (tone?: string) =>
    tone === 'danger' ? 'btn btn-danger-soft' : tone === 'primary' ? 'btn btn-primary' : 'btn btn-soft'
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="alertdialog" aria-label={title}>
        <div className="sheet-handle" />
        <h2 style={{ marginBottom: 10 }}>{title}</h2>
        {text && <div className="small muted" style={{ marginBottom: 16 }}>{text}</div>}
        <div className="stack">
          {actions.map(a => (
            <button key={a.label} className={`${cls(a.tone)} btn-block`} onClick={a.onClick}>{a.label}</button>
          ))}
          <button className="btn btn-ghost btn-block" onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </>
  )
}

// ---------- Progresso ----------
export function Progress({ pct, tone }: { pct: number; tone?: 'warn' | 'danger' }) {
  return (
    <div className="progress-track">
      <div className={`progress-fill ${tone || ''}`} style={{ width: `${Math.max(Math.min(pct, 100), 0)}%` }} />
    </div>
  )
}

// ---------- Empty state (seção 43) ----------
export function EmptyState({ emoji, text, cta, onCta }: { emoji: string; text: string; cta?: string; onCta?: () => void }) {
  return (
    <div className="empty-state">
      <div className="emoji">{emoji}</div>
      <p className="muted" style={{ marginBottom: 16 }}>{text}</p>
      {cta && <button className="btn btn-primary" onClick={onCta}>{cta}</button>}
    </div>
  )
}

// ---------- Valor com cor ----------
export const Money = ({ v, signed = false }: { v: number; signed?: boolean }) => (
  <span className={v >= 0 ? 'amount-pos' : 'amount-neg'}>
    {signed && v > 0 ? '+' : ''}{fmtBRL(v)}
  </span>
)

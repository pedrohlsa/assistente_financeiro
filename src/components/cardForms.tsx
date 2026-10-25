// Formulários de cartões, compras parceladas, faturas e assinaturas.
// Nenhum deles cria despesa em `transactions`: compras viram InstallmentPlan e
// só as parcelas entram no fluxo mensal (ver services/cards.ts).
import React, { useMemo, useState } from 'react'
import { useStore } from '../store/store'
import { ConfirmDialog, MoneyInput, useToast } from './ui'
import {
  CreditCard, Installment, InstallmentPlan, RecurringCardCharge,
} from '../models/types'
import { fmtBRL, fmtDateShort, nowPaymentTime, parseMoney, todayISO, uid } from '../utils/format'
import {
  activeCards, buildInstallments, cardInvoice, cardById, findCardByExactName, planInstallments,
  round2, settleableInstallmentIds, simulatePurchase, splitInstallmentAmounts, suggestedDueDay, suggestedFirstDueDate,
} from '../services/cards'
import { monthKey } from '../utils/format'
import { currentBalance } from '../services/calc'
import { sentenceCase } from '../utils/text'

const CARD_COLORS = ['#6C5CE7', '#0984E3', '#00B894', '#E17055', '#D63031', '#2D3436']

/**
 * Número de parcelas válido, ou null. Nunca "corrige" um valor absurdo em
 * silêncio — o formulário mostra o erro e não deixa salvar.
 */
function clampCount(v: string): number | null {
  const n = parseInt(String(v).trim(), 10)
  if (!Number.isFinite(n) || n < 1 || n > 120) return null
  return n
}

export function CardForm({ onDone, card: initialCard }: { onDone: () => void; card?: CreditCard }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  // Ao escolher "Editar o existente" o formulário passa a editar o cartão duplicado.
  const [card, setCard] = useState<CreditCard | undefined>(initialCard)
  const [name, setName] = useState(card?.name || '')
  const [institution, setInstitution] = useState(card?.institution || '')
  const [last4, setLast4] = useState(card?.lastFourDigits || '')
  const [limit, setLimit] = useState(card ? String(card.limit) : '')
  const [closingDay, setClosingDay] = useState(String(card?.closingDay ?? 25))
  const [dueDay, setDueDay] = useState(card ? String(card.dueDay) : '')
  const [initial, setInitial] = useState(card?.initialInvoiceBalance ? String(card.initialInvoiceBalance) : '')
  const [color, setColor] = useState(card?.color || CARD_COLORS[0])
  const [notes, setNotes] = useState(card?.notes || '')
  const [askDuplicate, setAskDuplicate] = useState(false)

  /** Dia do mês válido. Devolve null em vez de corrigir em silêncio. */
  const dayValue = (v: string): number | null => {
    const t = v.trim()
    if (!t) return null
    if (!/^\d{1,2}$/.test(t)) return null
    const n = parseInt(t, 10)
    return n >= 1 && n <= 31 ? n : null
  }

  const closing = dayValue(closingDay)
  const dueTyped = dueDay.trim() ? dayValue(dueDay) : null
  const dueSuggested = closing ? suggestedDueDay(closing) : null
  const effectiveDue = dueTyped ?? dueSuggested

  const closingError = closingDay.trim() && closing === null
    ? 'Informe um dia entre 1 e 31.' : ''
  const dueError = dueDay.trim() && dueTyped === null
    ? 'Informe um dia entre 1 e 31 ou deixe em branco.' : ''

  const duplicate = findCardByExactName(state, name, card?.id)
  const sameLast4 = !!duplicate && !!last4.replace(/\D/g, '') &&
    duplicate.lastFourDigits === last4.replace(/\D/g, '').slice(-4)
  const valid = !!name.trim() && closing !== null && !dueError && effectiveDue !== null

  const commit = () => {
    if (!valid) return
    const patch = {
      name: name.trim(),
      institution: institution.trim() || undefined,
      lastFourDigits: last4.replace(/\D/g, '').slice(-4) || undefined,
      limit: parseMoney(limit) || 0,
      closingDay: closing!,
      dueDay: effectiveDue!,
      initialInvoiceBalance: parseMoney(initial) || undefined,
      color,
      notes: notes.trim() || undefined,
    }
    if (card) {
      dispatch({ type: 'updateCard', id: card.id, patch })
      toast({ text: 'Cartão atualizado.' })
    } else {
      dispatch({ type: 'addCard', card: { id: uid(), ...patch, createdAt: todayISO() } })
      toast({ text: 'Cartão cadastrado. 💳' })
    }
    setAskDuplicate(false)
    onDone()
  }

  const save = () => {
    if (!valid) return
    // Duplicidade não bloqueia: dá para ter dois cartões com nome parecido.
    if (duplicate) { setAskDuplicate(true); return }
    commit()
  }

  /** Carrega o cartão duplicado no formulário em vez de criar um segundo. */
  const editExisting = () => {
    const c = duplicate!
    setCard(c)
    setName(c.name)
    setInstitution(c.institution || '')
    setLast4(c.lastFourDigits || '')
    setLimit(String(c.limit))
    setClosingDay(String(c.closingDay))
    setDueDay(String(c.dueDay))
    setInitial(c.initialInvoiceBalance ? String(c.initialInvoiceBalance) : '')
    setColor(c.color || CARD_COLORS[0])
    setNotes(c.notes || '')
    setAskDuplicate(false)
    toast({ text: `Editando o cartão “${c.name}”.` })
  }

  return (
    <div className="stack">
      <p className="tiny">
        Não pedimos o número completo do cartão, código de segurança nem senha — só o
        necessário para acompanhar faturas e limites.
      </p>
      <div className="form-grid">
        <div className="field full"><label>Nome do cartão</label>
          <input className="input" autoFocus placeholder="ex.: Nubank, Cartão do banco X" value={name} onChange={e => setName(e.target.value)} />
        </div>
        <div className="field"><label>Instituição (opcional)</label>
          <input className="input" placeholder="ex.: Nu, Inter" value={institution} onChange={e => setInstitution(e.target.value)} />
        </div>
        <div className="field"><label>Final (4 dígitos, opcional)</label>
          <input className="input" inputMode="numeric" maxLength={4} placeholder="1234" value={last4} onChange={e => setLast4(e.target.value)} />
        </div>
        <div className="field"><label>Limite total (R$)</label>
          <MoneyInput value={limit} onChange={setLimit} />
        </div>
        <div className="field"><label>Fatura atual em aberto (opcional)</label>
          <MoneyInput value={initial} onChange={setInitial} />
        </div>
        <div className="field"><label>Dia do fechamento</label>
          <input className="input" inputMode="numeric" maxLength={2} value={closingDay} onChange={e => setClosingDay(e.target.value)} />
          {closingError && <span className="tiny" style={{ color: 'var(--danger)' }}>{closingError}</span>}
        </div>
        <div className="field"><label>Dia do vencimento</label>
          <input className="input" inputMode="numeric" maxLength={2} placeholder={dueSuggested ? String(dueSuggested) : ''} value={dueDay} onChange={e => setDueDay(e.target.value)} />
          {dueError
            ? <span className="tiny" style={{ color: 'var(--danger)' }}>{dueError}</span>
            : <span className="tiny">
                {dueDay.trim()
                  ? 'Dia em que a fatura vence.'
                  : dueSuggested
                    ? `Se ficar em branco, usaremos 7 dias após o fechamento — dia ${dueSuggested}. Você pode editar antes de salvar.`
                    : 'Se ficar em branco, usaremos 7 dias após o fechamento.'}
              </span>}
        </div>
        <div className="field full"><label>Cor de identificação</label>
          <div className="chips">
            {CARD_COLORS.map(c => (
              <button key={c} onClick={() => setColor(c)} aria-label={`Cor ${c}`}
                style={{
                  width: 34, height: 34, borderRadius: 10, background: c, flex: '0 0 auto', cursor: 'pointer',
                  border: color === c ? '3px solid var(--text)' : '1px solid var(--border)',
                }} />
            ))}
          </div>
        </div>
        <div className="field full"><label>Observações (opcional)</label>
          <input className="input" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      </div>
      <button className="btn btn-primary btn-block" disabled={!valid} onClick={save}>
        {card ? 'Salvar alterações' : 'Cadastrar cartão'}
      </button>

      <ConfirmDialog
        open={askDuplicate}
        onClose={() => setAskDuplicate(false)}
        title={sameLast4
          ? 'Este cartão parece já estar cadastrado com o mesmo nome e final.'
          : `Já existe um cartão chamado “${duplicate?.name || name}”.`}
        text={sameLast4
          ? `“${duplicate?.name}” já existe com o final ····${duplicate?.lastFourDigits}. Cadastrar de novo cria um segundo cartão e o limite passa a ser contado em dobro.`
          : 'Deseja cadastrar outro mesmo assim?'}
        actions={[
          { label: 'Cadastrar mesmo assim', onClick: commit, tone: sameLast4 ? 'soft' : 'primary' },
          { label: 'Editar o existente', onClick: editExisting },
        ]}
      />
    </div>
  )
}

/** Atalhos de parcelamento mais usados; "Mais" abre o campo numérico livre. */
const COUNT_SHORTCUTS = [1, 2, 3, 4]
const MAX_INSTALLMENTS = 120

/**
 * Explicação do ajuste de centavos. A divisão exata quase nunca fecha: a última
 * parcela absorve a diferença. O texto não pode parecer cobrança extra.
 */
function RoundingNote({ amounts, total }: { amounts: number[]; total: number }) {
  if (amounts.length < 2) return null
  const last = amounts[amounts.length - 1]
  if (Math.abs(last - amounts[0]) < 0.005) return null
  const diff = Math.round((last - amounts[0]) * 100) / 100
  return (
    <p className="tiny" style={{ margin: '4px 0 0' }}>
      {amounts.length - 1} parcelas de {fmtBRL(amounts[0])} · última parcela de {fmtBRL(last)}.
      A última parcela recebeu um ajuste de {fmtBRL(Math.abs(diff))} para que a soma seja
      exatamente {fmtBRL(total)}.
    </p>
  )
}

/** Seletor de parcelas com atalhos (item 16). */
function InstallmentCount({ count, setCount }: { count: string; setCount: (v: string) => void }) {
  const n = parseInt(count, 10)
  const isShortcut = COUNT_SHORTCUTS.includes(n)
  const [free, setFree] = useState(!isShortcut)
  const invalid = count.trim() !== '' && (!Number.isFinite(n) || n < 1 || n > MAX_INSTALLMENTS)
  return (
    <div className="field full">
      <label>Parcelas</label>
      <div className="chips">
        {COUNT_SHORTCUTS.map(c => (
          <button key={c} className={`chip ${!free && n === c ? 'active' : ''}`}
            onClick={() => { setFree(false); setCount(String(c)) }}>{c}x</button>
        ))}
        <button className={`chip ${free ? 'active' : ''}`} onClick={() => setFree(true)}>Mais</button>
      </div>
      {free && (
        <input className="input" inputMode="numeric" autoFocus style={{ marginTop: 8 }}
          placeholder={`Quantas parcelas? (até ${MAX_INSTALLMENTS})`}
          value={count} onChange={e => setCount(e.target.value.replace(/\D/g, ''))} />
      )}
      {invalid && (
        <span className="tiny" style={{ color: 'var(--danger)' }}>
          Informe um número de parcelas entre 1 e {MAX_INSTALLMENTS}.
        </span>
      )}
    </div>
  )
}

/** Compra no crédito — à vista (1x) ou parcelada. */
export function PurchaseForm({ onDone, defaultCardId }: { onDone: () => void; defaultCardId?: string }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const cards = activeCards(state)
  const [cardId, setCardId] = useState(defaultCardId || cards[0]?.id || '')
  const [description, setDescription] = useState('')
  const [total, setTotal] = useState('')
  const [count, setCount] = useState('1')
  const [purchaseDate, setPurchaseDate] = useState(todayISO())
  const [category, setCategory] = useState('compras')
  const [origin, setOrigin] = useState('')
  const [interest, setInterest] = useState('')
  const [note, setNote] = useState('')
  const [customFirstDue, setCustomFirstDue] = useState('')

  const card = cardById(state, cardId)
  // Valor da compra + juros = TOTAL FINANCIADO. É o total financiado que vira
  // parcelas, fatura e projeção — os juros não podem ficar só decorando a tela.
  const principalV = parseMoney(total) || 0
  const interestV = parseMoney(interest) || 0
  const financedV = round2(principalV + interestV)
  const n = clampCount(count)
  const firstDue = customFirstDue || suggestedFirstDueDate(card, purchaseDate)
  const preview = financedV > 0 && n ? simulatePurchase(financedV, n, firstDue) : null
  const amounts = financedV > 0 && n ? splitInstallmentAmounts(financedV, n) : []

  const cats = state.categories.filter(c => c.type === 'expense' && !c.archived)
  const valid = principalV > 0 && n !== null

  const save = () => {
    if (!valid) return
    const plan: InstallmentPlan = {
      id: uid(),
      description: sentenceCase(description) || 'Compra no cartão',
      cardId: cardId || undefined,
      categoryId: category,
      totalAmount: financedV,
      principalAmount: interestV > 0 ? principalV : undefined,
      installmentCount: n!,
      firstDueDate: firstDue,
      purchaseDate,
      interestAmount: interestV > 0 ? interestV : undefined,
      source: origin.trim() || undefined,
      status: 'active',
      operationType: cardId ? 'card-purchase' : 'standalone',
      note: note.trim() || undefined,
      profileAtCreation: state.settings.profile,
      createdAt: todayISO(),
    }
    dispatch({ type: 'addPlan', plan, installments: buildInstallments(plan, uid) })
    toast({ text: n! > 1 ? `Compra em ${n}x registrada.` : 'Compra registrada.' })
    onDone()
  }

  return (
    <div className="stack">
      {cards.length === 0 && (
        <p className="tiny">Nenhum cartão cadastrado — a compra será registrada como parcelamento sem cartão.</p>
      )}
      <div className="form-grid">
        <div className="field full"><label>O que você comprou?</label>
          <input className="input" autoFocus placeholder="ex.: computador, geladeira" value={description} onChange={e => setDescription(e.target.value)} />
        </div>
        <div className="field"><label>Valor da compra (R$)</label>
          <MoneyInput value={total} onChange={setTotal} />
        </div>
        <div className="field"><label>Juros ou acréscimo total (opcional)</label>
          <MoneyInput value={interest} onChange={setInterest} />
          <span className="tiny">Valor adicional cobrado além do preço da compra.</span>
        </div>
        <InstallmentCount count={count} setCount={setCount} />
        {cards.length > 0 && (
          <div className="field full"><label>Cartão</label>
            <select className="input" value={cardId} onChange={e => setCardId(e.target.value)}>
              {cards.map(c => <option key={c.id} value={c.id}>{c.name}{c.lastFourDigits ? ` ····${c.lastFourDigits}` : ''}</option>)}
              <option value="">Sem cartão (boleto, carnê, acordo)</option>
            </select>
          </div>
        )}
        <div className="field"><label>Data da compra</label>
          <input type="date" className="input" value={purchaseDate} onChange={e => setPurchaseDate(e.target.value)} />
        </div>
        <div className="field"><label>1º vencimento</label>
          <input type="date" className="input" value={firstDue} onChange={e => setCustomFirstDue(e.target.value)} />
        </div>
        <div className="field full"><label>Categoria</label>
          <select className="input" value={category} onChange={e => setCategory(e.target.value)}>
            {cats.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
          </select>
        </div>
        <div className="field full"><label>Estabelecimento (opcional)</label>
          <input className="input" value={origin} onChange={e => setOrigin(e.target.value)} />
        </div>
        <div className="field full"><label>Observação (opcional)</label>
          <input className="input" value={note} onChange={e => setNote(e.target.value)} />
        </div>
      </div>

      {preview && (
        <div className="card" style={{ padding: '12px 14px', background: 'var(--accent-soft)', borderColor: 'transparent' }}>
          {interestV > 0 && (
            <div className="stack tiny" style={{ gap: 3, marginBottom: 8 }}>
              <div className="spread"><span>Valor da compra</span><span className="mono-num">{fmtBRL(principalV)}</span></div>
              <div className="spread"><span>+ Juros ou acréscimo</span><span className="mono-num">{fmtBRL(interestV)}</span></div>
              <div className="spread" style={{ fontWeight: 700 }}><span>= Total financiado</span><span className="mono-num">{fmtBRL(financedV)}</span></div>
            </div>
          )}
          <p className="small" style={{ margin: 0, fontWeight: 650 }}>
            {n! > 1 ? `${n}x de ${fmtBRL(preview.installmentAmount)}` : `1x de ${fmtBRL(preview.installmentAmount)}`} · total {fmtBRL(preview.totalAmount)}
          </p>
          <p className="tiny" style={{ margin: '4px 0 0' }}>
            1ª parcela em {fmtDateShort(preview.firstDueDate)}
            {n! > 1 ? ` · última em ${fmtDateShort(preview.lastDueDate)}` : ''}
          </p>
          <RoundingNote amounts={amounts} total={financedV} />
          <p className="tiny" style={{ margin: '4px 0 0' }}>
            Sua projeção mensal será reduzida em {fmtBRL(preview.installmentAmount)} pelos próximos {n} mês(es).
          </p>
        </div>
      )}
      <button className="btn btn-primary btn-block" disabled={!valid} onClick={save}>Registrar compra</button>
    </div>
  )
}

/** Recebeu dinheiro agora e ficou com dívida parcelada no cartão (seção 7). */
export function FinancedInflowForm({ onDone }: { onDone: () => void }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const cards = activeCards(state)
  const [cardId, setCardId] = useState(cards[0]?.id || '')
  const [charged, setCharged] = useState('')
  const [received, setReceived] = useState('')
  const [count, setCount] = useState('1')
  const [date, setDate] = useState(todayISO())
  const [source, setSource] = useState('')
  const [note, setNote] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [customFirstDue, setCustomFirstDue] = useState('')

  const card = cardById(state, cardId)
  const chargedV = parseMoney(charged) || 0
  const receivedV = parseMoney(received) || 0
  const cost = Math.max(chargedV - receivedV, 0)
  const n = clampCount(count) ?? 1
  const firstDue = customFirstDue || suggestedFirstDueDate(card, date)
  const amounts = chargedV > 0 ? splitInstallmentAmounts(chargedV, n) : []
  const valid = chargedV > 0 && receivedV > 0 && receivedV <= chargedV && confirmed && clampCount(count) !== null

  const save = () => {
    if (!valid) return
    const plan: InstallmentPlan = {
      id: uid(),
      description: 'Entrada financiada pelo cartão',
      cardId: cardId || undefined,
      categoryId: 'outros-out',
      totalAmount: chargedV,
      installmentCount: n,
      firstDueDate: firstDue,
      purchaseDate: date,
      feeAmount: cost,
      source: source.trim() || undefined,
      status: 'active',
      operationType: 'financed-cash-inflow',
      netReceived: receivedV,
      note: note.trim() || undefined,
      profileAtCreation: state.settings.profile,
      createdAt: todayISO(),
    }
    dispatch({ type: 'addPlan', plan, installments: buildInstallments(plan, uid) })
    // Dinheiro que entrou no caixa — NUNCA classificado como receita/lucro.
    dispatch({
      type: 'addTx',
      tx: {
        id: uid(), type: 'financed-cash-inflow', amount: receivedV, category: 'outros-in',
        description: 'Entrada financiada pelo cartão', date, source: 'manual',
        profileAtCreation: state.settings.profile,
      },
    })
    dispatch({ type: 'settings', patch: { balance: (state.settings.balance || 0) + receivedV } })
    toast({ text: 'Operação registrada.' })
    onDone()
  }

  return (
    <div className="stack">
      <p className="small muted">
        Use isto quando você recebeu dinheiro agora e ficou com uma dívida parcelada no cartão.
        O valor recebido <strong>não</strong> é contado como renda, salário ou lucro — seu
        patrimônio não aumentou, você apenas antecipou dinheiro assumindo uma dívida.
      </p>
      <div className="form-grid">
        {cards.length > 0 && (
          <div className="field full"><label>Cartão utilizado</label>
            <select className="input" value={cardId} onChange={e => setCardId(e.target.value)}>
              {cards.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="">Sem cartão cadastrado</option>
            </select>
          </div>
        )}
        <div className="field"><label>Valor cobrado no cartão (R$)</label>
          <MoneyInput autoFocus value={charged} onChange={setCharged} />
        </div>
        <div className="field"><label>Valor líquido recebido (R$)</label>
          <MoneyInput value={received} onChange={setReceived} />
        </div>
        <InstallmentCount count={count} setCount={setCount} />
        <div className="field full"><label>Data da operação</label>
          <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="field full"><label>1º vencimento</label>
          <input type="date" className="input" value={firstDue} onChange={e => setCustomFirstDue(e.target.value)} />
        </div>
        <div className="field full"><label>Pessoa ou estabelecimento (opcional)</label>
          <input className="input" value={source} onChange={e => setSource(e.target.value)} />
        </div>
        <div className="field full"><label>Observação (opcional)</label>
          <input className="input" value={note} onChange={e => setNote(e.target.value)} />
        </div>
      </div>

      {chargedV > 0 && receivedV > 0 && (
        <div className="card" style={{ padding: '12px 14px', background: 'var(--accent-soft)', borderColor: 'transparent' }}>
          <div className="stack tiny" style={{ gap: 3 }}>
            <div className="spread"><span>Entrou no caixa agora</span><span className="mono-num">{fmtBRL(receivedV)}</span></div>
            <div className="spread"><span>Dívida assumida no cartão</span><span className="mono-num amount-neg">{fmtBRL(chargedV)}</span></div>
            <div className="spread" style={{ fontWeight: 700 }}><span>Custo da operação</span><span className="mono-num amount-neg">{fmtBRL(cost)}</span></div>
            {amounts.length > 0 && (
              <div className="spread"><span>Parcelas</span><span className="mono-num">{n}x de {fmtBRL(amounts[0])}</span></div>
            )}
            <div className="divider" style={{ margin: '6px 0' }} />
            <p style={{ margin: 0 }}>
              Seu patrimônio líquido <strong>não</strong> aumentou {fmtBRL(receivedV)}: você recebeu
              esse valor e passou a dever {fmtBRL(chargedV)}, um custo de {fmtBRL(cost)}.
            </p>
          </div>
        </div>
      )}
      {receivedV > chargedV && chargedV > 0 && (
        <p className="tiny" style={{ color: 'var(--danger)' }}>O valor recebido não pode ser maior que o valor cobrado no cartão.</p>
      )}

      <label className="row" style={{ gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
        <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} style={{ marginTop: 3 }} />
        <span className="tiny">Confirmo que desejo registrar esta operação já realizada.</span>
      </label>
      <p className="tiny">
        Esta função apenas registra e projeta uma operação financeira já realizada. Verifique as
        regras contratuais da operadora, da instituição e a legislação aplicável.
      </p>
      <button className="btn btn-primary btn-block" disabled={!valid} onClick={save}>Registrar operação</button>
    </div>
  )
}

/** Parcelamento sem cartão: empréstimo, boleto, acordo, crediário, imposto. */
export function StandalonePlanForm({ onDone }: { onDone: () => void }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const [description, setDescription] = useState('')
  const [total, setTotal] = useState('')
  const [count, setCount] = useState('12')
  const [alreadyPaid, setAlreadyPaid] = useState('0')
  const [firstDue, setFirstDue] = useState(todayISO())
  const [category, setCategory] = useState('outros-out')
  const [source, setSource] = useState('')
  const [interest, setInterest] = useState('')
  const [note, setNote] = useState('')

  // Mesma regra da compra no crédito: os juros entram no total financiado, que
  // é o que vira parcela, fatura e projeção.
  const principalV = parseMoney(total) || 0
  const interestV = parseMoney(interest) || 0
  const financedV = round2(principalV + interestV)
  const countOk = clampCount(count)
  const n = countOk ?? 1
  const paidCount = Math.min(Math.max(parseInt(alreadyPaid, 10) || 0, 0), n)
  const amounts = financedV > 0 && countOk ? splitInstallmentAmounts(financedV, n) : []
  const cats = state.categories.filter(c => c.type === 'expense' && !c.archived)
  const valid = principalV > 0 && !!description.trim() && countOk !== null

  const save = () => {
    if (!valid) return
    const plan: InstallmentPlan = {
      id: uid(),
      description: sentenceCase(description),
      categoryId: category,
      totalAmount: financedV,
      principalAmount: interestV > 0 ? principalV : undefined,
      installmentCount: n,
      firstDueDate: firstDue,
      purchaseDate: todayISO(),
      interestAmount: interestV > 0 ? interestV : undefined,
      source: source.trim() || undefined,
      status: paidCount >= n ? 'settled' : 'active',
      operationType: 'standalone',
      note: note.trim() || undefined,
      profileAtCreation: state.settings.profile,
      createdAt: todayISO(),
    }
    const installments = buildInstallments(plan, uid).map((i, idx): Installment =>
      idx < paidCount ? { ...i, status: 'paid', paidAt: i.dueDate, paidAmount: i.amount } : i)
    dispatch({ type: 'addPlan', plan, installments })
    toast({ text: 'Parcelamento registrado.' })
    onDone()
  }

  return (
    <div className="stack">
      <p className="tiny">Empréstimo, carnê, acordo de dívida, crediário, imposto parcelado ou compra dividida com alguém.</p>
      <div className="form-grid">
        <div className="field full"><label>Descrição</label>
          <input className="input" autoFocus placeholder="ex.: empréstimo, acordo, carnê da loja" value={description} onChange={e => setDescription(e.target.value)} />
        </div>
        <div className="field"><label>Valor total (R$)</label>
          <MoneyInput value={total} onChange={setTotal} />
        </div>
        <div className="field"><label>Juros ou acréscimo total (opcional)</label>
          <MoneyInput value={interest} onChange={setInterest} />
          <span className="tiny">Valor adicional cobrado além do valor original.</span>
        </div>
        <InstallmentCount count={count} setCount={setCount} />
        <div className="field"><label>Parcelas já pagas</label>
          <input className="input" inputMode="numeric" value={alreadyPaid} onChange={e => setAlreadyPaid(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="field"><label>1º vencimento</label>
          <input type="date" className="input" value={firstDue} onChange={e => setFirstDue(e.target.value)} />
        </div>
        <div className="field full"><label>Categoria</label>
          <select className="input" value={category} onChange={e => setCategory(e.target.value)}>
            {cats.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
          </select>
        </div>
        <div className="field full"><label>Credor / origem (opcional)</label>
          <input className="input" value={source} onChange={e => setSource(e.target.value)} />
        </div>
        <div className="field full"><label>Observação (opcional)</label>
          <input className="input" value={note} onChange={e => setNote(e.target.value)} />
        </div>
      </div>
      {amounts.length > 0 && (
        <div className="card" style={{ padding: '12px 14px', background: 'var(--accent-soft)', borderColor: 'transparent' }}>
          {interestV > 0 && (
            <div className="stack tiny" style={{ gap: 3, marginBottom: 8 }}>
              <div className="spread"><span>Valor original</span><span className="mono-num">{fmtBRL(principalV)}</span></div>
              <div className="spread"><span>+ Juros ou acréscimo</span><span className="mono-num">{fmtBRL(interestV)}</span></div>
              <div className="spread" style={{ fontWeight: 700 }}><span>= Total financiado</span><span className="mono-num">{fmtBRL(financedV)}</span></div>
            </div>
          )}
          <p className="small" style={{ margin: 0, fontWeight: 650 }}>{n}x de {fmtBRL(amounts[0])} · total {fmtBRL(financedV)}</p>
          <RoundingNote amounts={amounts} total={financedV} />
          {paidCount > 0 && <p className="tiny" style={{ margin: '4px 0 0' }}>{paidCount} parcela(s) já paga(s) — faltam {n - paidCount}.</p>}
        </div>
      )}
      <button className="btn btn-primary btn-block" disabled={!valid} onClick={save}>Registrar parcelamento</button>
    </div>
  )
}

/** Pagamento de fatura — total ou parcial. Não gera despesa nova. */
export function CardPaymentForm({ onDone, card, referenceMonth }: { onDone: () => void; card: CreditCard; referenceMonth?: string }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const mk = referenceMonth || monthKey(todayISO())
  const invoice = useMemo(() => cardInvoice(state, card, mk), [state, card, mk])
  const [amount, setAmount] = useState(invoice.pending > 0 ? String(invoice.pending.toFixed(2)).replace('.', ',') : '')
  const [date, setDate] = useState(todayISO())
  const [fromBalance, setFromBalance] = useState(true)
  const [note, setNote] = useState('')
  const [confirmOver, setConfirmOver] = useState(false)

  const v = parseMoney(amount) || 0
  const over = v > invoice.pending + 0.009
  const valid = v > 0 && (!over || confirmOver)

  const save = () => {
    if (!valid) return
    const fullyPaid = v >= invoice.pending - 0.009
    const settleIds = fullyPaid ? settleableInstallmentIds(state, invoice) : []
    dispatch({
      type: 'addCardPayment',
      payment: { id: uid(), cardId: card.id, amount: v, paymentDate: date,
        paymentTime: date === todayISO() ? nowPaymentTime() : undefined,
        referenceMonth: mk, note: note.trim() || undefined, fromBalance,
        settledInstallmentIds: settleIds },
      settleInstallmentIds: settleIds,
    })
    toast({ text: fullyPaid ? 'Fatura quitada. ✅' : `Pagamento parcial de ${fmtBRL(v)} registrado.` })
    onDone()
  }

  return (
    <div className="stack">
      <div className="card" style={{ padding: '12px 14px', background: 'var(--accent-soft)', borderColor: 'transparent' }}>
        <div className="stack tiny" style={{ gap: 3 }}>
          <div className="spread"><span>Total da fatura</span><span className="mono-num">{fmtBRL(invoice.total)}</span></div>
          <div className="spread"><span>Já pago</span><span className="mono-num amount-pos">{fmtBRL(invoice.paid)}</span></div>
          <div className="spread" style={{ fontWeight: 700 }}><span>Pendente</span><span className="mono-num">{fmtBRL(invoice.pending)}</span></div>
          <div className="spread"><span>Vencimento</span><span>{fmtDateShort(invoice.dueDate)}</span></div>
        </div>
      </div>
      <p className="tiny">
        Pagar a fatura não cria uma despesa nova — as compras já foram contadas como parcelas.
        Este registro apenas quita a dívida do cartão.
      </p>
      <div className="form-grid">
        <div className="field"><label>Valor pago (R$)</label>
          <MoneyInput autoFocus value={amount} onChange={setAmount} />
        </div>
        <div className="field"><label>Data do pagamento</label>
          <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="field full"><label>Observação (opcional)</label>
          <input className="input" value={note} onChange={e => setNote(e.target.value)} />
        </div>
      </div>
      <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={fromBalance} onChange={e => setFromBalance(e.target.checked)} />
        <span className="tiny">Descontar do meu saldo em conta ({fmtBRL(currentBalance(state))})</span>
      </label>
      {over && (
        <div className="card" style={{ padding: '10px 14px', borderColor: 'var(--warning)', borderWidth: 1.5 }}>
          <p className="tiny" style={{ margin: 0 }}>
            Você está pagando {fmtBRL(v - invoice.pending)} a mais do que o valor pendente ({fmtBRL(invoice.pending)}).
          </p>
          <label className="row" style={{ gap: 8, marginTop: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={confirmOver} onChange={e => setConfirmOver(e.target.checked)} />
            <span className="tiny">Confirmo o valor acima do pendente.</span>
          </label>
        </div>
      )}
      <button className="btn btn-primary btn-block" disabled={!valid} onClick={save}>Registrar pagamento</button>
    </div>
  )
}

/** Assinatura recorrente no cartão — não tem número de parcelas. */
export function CardChargeForm({ onDone, charge }: { onDone: () => void; charge?: RecurringCardCharge }) {
  const { state, dispatch } = useStore()
  const toast = useToast()
  const cards = activeCards(state)
  const [cardId, setCardId] = useState(charge?.cardId || cards[0]?.id || '')
  const [description, setDescription] = useState(charge?.description || '')
  const [amount, setAmount] = useState(charge ? String(charge.amount) : '')
  const [category, setCategory] = useState(charge?.categoryId || 'assinaturas')
  const [frequency, setFrequency] = useState<RecurringCardCharge['frequency']>(charge?.frequency || 'monthly')
  const [nextDate, setNextDate] = useState(charge?.nextDate || todayISO())
  const [endDate, setEndDate] = useState(charge?.endDate || '')

  const v = parseMoney(amount) || 0
  const cats = state.categories.filter(c => c.type === 'expense' && !c.archived)

  const save = () => {
    if (!(v > 0) || !description.trim() || !cardId) return
    const patch = {
      cardId, description: sentenceCase(description), amount: v, categoryId: category,
      frequency, nextDate, endDate: endDate || undefined,
    }
    if (charge) {
      dispatch({ type: 'updateCardCharge', id: charge.id, patch })
      toast({ text: 'Assinatura atualizada.' })
    } else {
      dispatch({ type: 'addCardCharge', charge: { id: uid(), ...patch, active: true, createdAt: todayISO() } })
      toast({ text: 'Assinatura cadastrada.' })
    }
    onDone()
  }

  return (
    <div className="stack">
      <p className="tiny">
        Cobrança que se repete até você cancelar — streaming, internet, academia, seguro.
        Não é parcelamento: não tem número de parcelas definido.
      </p>
      <div className="form-grid">
        <div className="field full"><label>Descrição</label>
          <input className="input" autoFocus placeholder="ex.: Netflix, academia" value={description} onChange={e => setDescription(e.target.value)} />
        </div>
        <div className="field"><label>Valor (R$)</label>
          <MoneyInput value={amount} onChange={setAmount} />
        </div>
        <div className="field"><label>Cartão</label>
          <select className="input" value={cardId} onChange={e => setCardId(e.target.value)}>
            {cards.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field"><label>Frequência</label>
          <select className="input" value={frequency} onChange={e => setFrequency(e.target.value as any)}>
            <option value="monthly">Mensal</option><option value="yearly">Anual</option>
          </select>
        </div>
        <div className="field"><label>Categoria</label>
          <select className="input" value={category} onChange={e => setCategory(e.target.value)}>
            {cats.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
          </select>
        </div>
        <div className="field"><label>Próxima cobrança</label>
          <input type="date" className="input" value={nextDate} onChange={e => setNextDate(e.target.value)} />
        </div>
        <div className="field"><label>Data final (opcional)</label>
          <input type="date" className="input" value={endDate} onChange={e => setEndDate(e.target.value)} />
        </div>
      </div>
      <button className="btn btn-primary btn-block" disabled={!(v > 0) || !description.trim() || !cardId} onClick={save}>
        {charge ? 'Salvar' : 'Cadastrar assinatura'}
      </button>
    </div>
  )
}

import { PullToRefresh, StatusBadge } from '@capo/ui';

/**
 * The app's scroller. It owns the pull gesture AND the overflow — globals.css
 * removes the document scroll port, so every screen's content lives inside
 * this. The gesture itself cannot be shown statically; what these cells show
 * is the scroller doing its ordinary job.
 */
export function AroundAList() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 260, maxWidth: 460, border: '1px solid rgba(113,113,122,0.2)', borderRadius: 12, overflow: 'hidden' }}>
      <PullToRefresh locale="pt-PT">
        <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {['Assentar azulejos', 'Pintar tecto do quarto', 'Ligar quadro eléctrico', 'Montar rodapé', 'Selar juntas', 'Limpeza final'].map((t, i) => (
            <div key={t} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 14 }}>{t}</span>
              <StatusBadge status={i === 0 ? 'in_progress' : i === 1 ? 'pending_review' : 'done'} locale="pt-PT" />
            </div>
          ))}
        </div>
      </PullToRefresh>
    </div>
  );
}

/** Suppressed. The chat passes `disabled` while a reply is streaming. */
export function GestureDisabled() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 180, maxWidth: 460, border: '1px solid rgba(113,113,122,0.2)', borderRadius: 12, overflow: 'hidden' }}>
      <PullToRefresh locale="pt-PT" disabled>
        <div style={{ padding: '0.75rem', fontSize: 14, color: '#71717a' }}>
          O Capo está a responder — o gesto de puxar está suspenso.
        </div>
      </PullToRefresh>
    </div>
  );
}

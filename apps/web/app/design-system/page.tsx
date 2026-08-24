import { notFound } from 'next/navigation';
import { Badge, type Tone } from '@capo/ui/badge';
import { Banner } from '@capo/ui/banner';
import { Button, ButtonLink, IconButton } from '@capo/ui/button';
import { Card } from '@capo/ui/card';
import { EmptyState } from '@capo/ui/empty-state';
import { Field, Input, Select, Textarea } from '@capo/ui/field';
import { ListRow } from '@capo/ui/list-row';
import { Skeleton } from '@capo/ui/skeleton';
import { AppBar } from '@capo/ui/app-bar';
import { TabBar } from '@/app/_ui/tab-bar';
import { InteractiveDemos } from './interactive';

// The design system, visible without logging in. Every component in every
// state, so a disabled button or a field with an error can be looked at
// directly instead of hunted for on a screen that happens to contain one.
//
// Dev-only, and the guard is a 404 rather than a redirect: a redirect
// announces that the route exists.
export const dynamic = 'force-dynamic';

const TONES: Tone[] = ['neutral', 'info', 'warn', 'danger', 'success', 'brand', 'review'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-hairline pt-6">
      <h2 className="text-heading font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

export default function DesignGallery() {
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <div className="mx-auto flex h-dvh w-full max-w-2xl flex-col overflow-y-auto bg-bg">
      <AppBar title="Design system" subtitle="Every component, every state" />
      <div className="flex flex-col gap-6 p-4">
        <Section title="Buttons — one primary per screen">
          <div className="flex flex-wrap gap-2">
            <Button variant="primary">Guardar</Button>
            <Button variant="secondary">Cancelar</Button>
            <Button variant="tertiary">Editar</Button>
            <Button variant="destructive">Apagar</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm">Small 44px</Button>
            <Button size="md">Medium 48px</Button>
            <Button size="lg">Large 56px</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button loading>Guardar</Button>
            <Button disabled>Guardar</Button>
            <Button fullWidth>Full width</Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="#">Ver obra</ButtonLink>
            <IconButton label="Fechar" icon={<span aria-hidden>✕</span>} />
          </div>
        </Section>

        <Section title="Badges">
          <div className="flex flex-wrap gap-2">
            {TONES.map(tone => (
              <Badge key={tone} tone={tone}>
                {tone}
              </Badge>
            ))}
          </div>
          {/* The second reading, shown beside the first because the whole
              point of it is the width difference. `shape` is 11px uppercase
              and is for badges recognised rather than read; `sentence` is 13px
              and is for the ones that are actually words — which is every task
              status Capo has in Portuguese. */}
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="review">A aguardar controlo</Badge>
            <Badge tone="review" reading="sentence">
              A aguardar controlo
            </Badge>
          </div>
        </Section>

        <Section title="Banners">
          <div className="flex flex-col gap-2">
            <Banner tone="danger" href="#">A tua subscrição expirou</Banner>
            <Banner tone="warn">Faltam 3 dias de teste</Banner>
            <Banner tone="info">2 notificações por ler</Banner>
          </div>
        </Section>

        <Section title="Card and rows">
          <Card padding="none">
            <ListRow title="Pintar tecto" meta="Casa de Paco — a ajudar Miguel" href="#" />
            <ListRow title="Assentar azulejo" meta="Atrasada 2 dias" danger href="#" />
            <ListRow
              title="Um título muito comprido que não cabe de maneira nenhuma nesta linha estreita"
              meta="Truncation check"
              trailing={<Badge tone="review">review</Badge>}
              href="#"
            />
          </Card>
        </Section>

        <Section title="Fields">
          <Card>
            <div className="flex flex-col gap-4">
              <Field id="g-name" label="Nome da obra" required>
                {a11y => <Input {...a11y} placeholder="Casa de Paco" />}
              </Field>
              <Field id="g-hint" label="Telefone" hint="Com indicativo do país">
                {a11y => <Input {...a11y} type="tel" placeholder="+351…" />}
              </Field>
              <Field id="g-err" label="Email" error="Esse email já está em uso">
                {a11y => <Input {...a11y} type="email" defaultValue="a@b.pt" />}
              </Field>
              <Field id="g-sel" label="Idioma">
                {a11y => (
                  <Select {...a11y} defaultValue="pt-PT">
                    <option value="pt-PT">Português</option>
                    <option value="es-ES">Español</option>
                    <option value="en-US">English</option>
                  </Select>
                )}
              </Field>
              <Field id="g-txt" label="Notas">
                {a11y => <Textarea {...a11y} rows={3} />}
              </Field>
            </div>
          </Card>
        </Section>

        <Section title="Empty and loading">
          <Card padding="none">
            <EmptyState
              title="Nada para hoje"
              body="Quando criares tarefas com data de hoje, aparecem aqui."
              action={<Button size="sm">Criar tarefa</Button>}
            />
          </Card>
          <Card>
            <Skeleton variant="title" />
            <div className="pt-2">
              <Skeleton variant="text" count={3} />
            </div>
          </Card>
        </Section>

        <Section title="Sheet and SegmentedControl">
          <InteractiveDemos />
        </Section>

        {/* The shell's own bar, which until the shell batch had been built and
            rendered NOWHERE — it existed only as a file. What this proves: the
            five labels still fit at 320px (which is what caps the tab count),
            the icons, the hairline and the safe-area padding.
            What it CANNOT show is the active tab: that is derived from
            usePathname, and no route under /design-system prefixes a tab href,
            so every tab here is drawn in its inactive, outline form. The active
            pair — brand colour AND a filled icon, because colour alone is not a
            signal roughly 1 man in 12 can read — has to be checked on a real
            route. */}
        <Section title="TabBar — inactive state only, see the note in the source">
          <TabBar locale="pt-PT" />
        </Section>

        <Section title="Type scale">
          <p className="text-display text-fg">Display 32</p>
          <p className="text-title text-fg">Title 22</p>
          <p className="text-heading text-fg">Heading 17</p>
          <p className="text-body text-fg">Body 16 — the default</p>
          <p className="text-callout text-fg-muted">Callout 15</p>
          <p className="text-caption text-fg-muted">Caption 13 — the floor</p>
          <p className="text-micro text-fg-faint uppercase">Micro 11 — badges only</p>
        </Section>
      </div>
    </div>
  );
}

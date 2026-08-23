import { SegmentedControl, Card } from '@capo/ui';

/** THE RADIO INPUTS ARE LOAD-BEARING. This is a plain <fieldset> of radios
 *  styled with peer-checked, precisely so a cold PWA on a slow phone — which
 *  is most of the time this is actually used — can select and save before any
 *  JavaScript has run. `onChange` only ENHANCES that; it never replaces it.
 *  Arrow-key navigation between radios comes free from the markup. */
export function Filters() {
  return (
    <div style={{ maxWidth: 380 }}>
      <SegmentedControl
        name="p-filter"
        legend="Que tarefas mostrar"
        value="hoje"
        options={[
          { value: 'hoje', label: 'Hoje' },
          { value: 'amanha', label: 'Amanhã' },
          { value: 'atrasadas', label: 'Atrasadas' },
          { value: 'todas', label: 'Todas' },
        ]}
      />
    </div>
  );
}

/** The language picker, one of the four hand-rolled pill sets this replaces. */
export function Language() {
  return (
    <div style={{ maxWidth: 380 }}>
      <SegmentedControl
        name="p-lang"
        legend="Idioma da app"
        value="pt-PT"
        options={[
          { value: 'pt-PT', label: 'Português' },
          { value: 'es-ES', label: 'Español' },
          { value: 'en-US', label: 'English' },
        ]}
      />
    </div>
  );
}

/** Two of them inside a settings card, which is where they actually live. */
export function InSettings() {
  return (
    <div style={{ maxWidth: 380 }}>
      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <p className="pb-2 text-callout font-medium text-fg">Aspecto</p>
            <SegmentedControl
              name="p-theme"
              legend="Aspecto da app"
              value="light"
              options={[
                { value: 'light', label: 'Claro' },
                { value: 'dark', label: 'Escuro' },
                { value: 'system', label: 'Sistema' },
              ]}
            />
          </div>
          <div>
            <p className="pb-2 text-callout font-medium text-fg">Idioma</p>
            <SegmentedControl
              name="p-lang2"
              legend="Idioma da app"
              value="es-ES"
              options={[
                { value: 'pt-PT', label: 'Português' },
                { value: 'es-ES', label: 'Español' },
                { value: 'en-US', label: 'English' },
              ]}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}

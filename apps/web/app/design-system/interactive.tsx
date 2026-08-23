'use client';

import { useState } from 'react';
import { Button } from '@capo/ui/button';
import { Sheet } from '@/app/_ui/sheet';
import { SegmentedControl } from '@/app/_ui/segmented-control';

export function InteractiveDemos() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState('light');
  return (
    <div className="flex flex-col gap-4">
      <SegmentedControl
        name="gallery-theme"
        legend="Aparência"
        value={theme}
        onChange={setTheme}
        options={[
          { value: 'light', label: 'Claro' },
          { value: 'dark', label: 'Escuro' },
          { value: 'system', label: 'Sistema' },
        ]}
      />
      <p className="text-caption text-fg-muted">Selected: {theme}</p>
      <Button onClick={() => setOpen(true)}>Abrir sheet</Button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Concluir tarefa">
        <div className="flex flex-col gap-3">
          <p className="text-heading text-fg">Concluir tarefa</p>
          <p className="text-callout text-fg-muted">
            Escape fecha. Tab fica preso aqui dentro. A página atrás não faz scroll.
          </p>
          <Button onClick={() => setOpen(false)}>Confirmar</Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

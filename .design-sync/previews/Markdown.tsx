import { Markdown } from '@capo/ui';

/**
 * What Capo actually replies with in chat. remark-breaks is enabled, so single
 * newlines become line breaks — the model writes WhatsApp-style, not strict
 * markdown, and collapsing them would mangle a task list.
 */
export function CapoReply() {
  return (
    <div style={{ padding: '0.75rem', maxWidth: 520 }}>
      <Markdown text={`Marquei **3 tarefas** para amanhã na Casa de Paco:

- Assentar azulejos — Miguel
- Pintar tecto — Zé
- Ligar quadro eléctrico — João

O betão ainda não secou, por isso deixei a betonilha para quinta.`} />
    </div>
  );
}

/** Single newlines held as line breaks — the remark-breaks behaviour. */
export function LineBreaksArePreserved() {
  return (
    <div style={{ padding: '0.75rem', maxWidth: 520 }}>
      <Markdown text={`Falta comprar:
Tinta branca 15L
Cola de azulejo
Rodapé 8cm`} />
    </div>
  );
}

/** Headings, ordered lists, links, quotes and inline `code` — the mono face. */
export function RichText() {
  return (
    <div style={{ padding: '0.75rem', maxWidth: 520 }}>
      <Markdown text={`## Resumo da semana

1. A obra da **Casa de Paco** está em dia
2. A *Moradia Alves* atrasou dois dias
3. Falta material na Loja Rua Augusta

> O Miguel disse que acaba a pintura na sexta.

O estado interno da tarefa é \`pending_review\` até aprovares.`} />
    </div>
  );
}

/** A link and a fenced code block — both carry their own styling in the map. */
export function LinksAndCodeBlock() {
  return (
    <div style={{ padding: '0.75rem', maxWidth: 520 }}>
      <Markdown text={`Vê a ficha técnica em [construcapo.com](https://construcapo.com).

A morada da obra ficou assim:

\`\`\`
Casa de Paco
Rua das Flores 12
4000-123 Porto
\`\`\`

Confirma antes de enviares ao Miguel.`} />
    </div>
  );
}

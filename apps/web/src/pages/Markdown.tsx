import type { ReactNode } from 'react';

// Rendu Markdown minimal et sûr (titres, listes, gras, paragraphes) : aucun
// HTML n'est injecté, le texte de l'IA est toujours échappé par React.

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong>
      : part.length > 2 && part.startsWith('*') && part.endsWith('*') ? <em key={i}>{part.slice(1, -1)}</em> : part);
}

export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let list: ReactNode[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(<p key={out.length}>{inline(para.join(' '))}</p>);
    if (list.length) out.push(<ul key={out.length}>{list}</ul>);
    para = [];
    list = [];
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (!line) flush();
    else if (h) {
      flush();
      out.push(h[1]!.length <= 1 ? <h2 key={out.length}>{inline(h[2]!)}</h2> : <h3 key={out.length}>{inline(h[2]!)}</h3>);
    } else if (li) {
      if (para.length) { out.push(<p key={out.length}>{inline(para.join(' '))}</p>); para = []; }
      list.push(<li key={list.length}>{inline(li[1]!)}</li>);
    } else {
      if (list.length) { out.push(<ul key={out.length}>{list}</ul>); list = []; }
      para.push(line);
    }
  }
  flush();
  return <div className="markdown">{out}</div>;
}

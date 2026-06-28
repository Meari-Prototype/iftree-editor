import { type ElementType, useMemo } from 'react';

import { parseMarkdownBlocks, renderTexMathToText } from '../../core/markdown.js';
import { useResolvedImageSources } from '../hooks/useResolvedImages.js';

type MarkdownInlineToken = {
  type?: string;
  text?: string;
};

type MarkdownBlockNode =
  | { type: 'heading'; level: number; text: string }
  | { type: 'image'; src: string; alt?: string }
  | { type: 'math'; text: string }
  | { type: 'paragraph'; children: MarkdownInlineToken[] };

interface MarkdownBlockProps {
  markdown: unknown;
  docId?: string | null;
}

export function MarkdownBlock({ markdown, docId }: MarkdownBlockProps) {
  const blocks = useMemo(() => parseMarkdownBlocks(markdown) as MarkdownBlockNode[], [markdown]);
  const resolvedImages = useResolvedImageSources(blocks, docId);

  return (
    <div className="markdown-block">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const Tag = (`h${Math.min(block.level, 4)}`) as ElementType;
          return <Tag key={index}>{block.text}</Tag>;
        }
        if (block.type === 'image') {
          return <img key={index} src={resolvedImages[block.src] || block.src} alt={block.alt} />;
        }
        if (block.type === 'math') {
          return <div key={index} className="math-block">{renderTexMathToText(block.text)}</div>;
        }
        return <p key={index}>{block.children.map((child, childIndex) => renderInline(child, childIndex))}</p>;
      })}
    </div>
  );
}

export function renderInline(token: MarkdownInlineToken, key: number) {
  if (token.type === 'strong') return <strong key={key}>{token.text}</strong>;
  if (token.type === 'code') return <code key={key}>{token.text}</code>;
  if (token.type === 'math') return <span key={key} className="math-inline">{renderTexMathToText(token.text)}</span>;
  return <span key={key}>{token.text}</span>;
}

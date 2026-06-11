import { useMemo } from 'react';

import { parseMarkdownBlocks, renderTexMathToText } from '../../core/markdown.mjs';
import { useResolvedImageSources } from '../hooks/useResolvedImages.js';

export function MarkdownBlock({ markdown, docId }) {
  const blocks = useMemo(() => parseMarkdownBlocks(markdown), [markdown]);
  const resolvedImages = useResolvedImageSources(blocks, docId);

  return (
    <div className="markdown-block">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const Tag = /** @type {any} */ (`h${Math.min(block.level, 4)}`);
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

export function renderInline(token, key) {
  if (token.type === 'strong') return <strong key={key}>{token.text}</strong>;
  if (token.type === 'code') return <code key={key}>{token.text}</code>;
  if (token.type === 'math') return <span key={key} className="math-inline">{renderTexMathToText(token.text)}</span>;
  return <span key={key}>{token.text}</span>;
}

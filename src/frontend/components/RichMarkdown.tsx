import { type ElementType, useMemo } from 'react';

import { renderTexMathToText } from '../../core/markdown.mjs';
import { parseRichMarkdown, richMarkdownImageSources } from '../../core/rich-markdown.mjs';
import { useResolvedImageSourcesForSources } from '../hooks/useResolvedImages.js';

// 无版面格式（md / txt / 节点正文 / agent 文本）统一的富文本渲染组件。
// 解析走 core/rich-markdown（值型、全块型），这里只把值型 block 映射成 React。
// 代码高亮 / 链接打开等增强后续补；当前先把结构正确铺出来。
export function RichMarkdown({ markdown = '', docId = null, className = '' }) {
  const blocks = useMemo(() => parseRichMarkdown(markdown), [markdown]);
  const imageSources = useMemo(() => richMarkdownImageSources(blocks), [blocks]);
  const resolvedImages = useResolvedImageSourcesForSources(imageSources, docId);
  const resolveSrc = (src) => resolvedImages[src] || src;
  return (
    <div className={`rich-markdown${className ? ` ${className}` : ''}`}>
      {blocks.map((block, index) => <RichBlock key={index} block={block} resolveSrc={resolveSrc} />)}
    </div>
  );
}

function RichBlock({ block, resolveSrc }) {
  if (block.type === 'heading') {
    const Tag = (`h${block.level}`) as ElementType;
    return <Tag>{renderInlineTokens(block.inline, resolveSrc)}</Tag>;
  }
  if (block.type === 'paragraph') {
    return <p>{renderInlineTokens(block.inline, resolveSrc)}</p>;
  }
  if (block.type === 'blockquote') {
    return <blockquote>{renderInlineTokens(block.inline, resolveSrc)}</blockquote>;
  }
  if (block.type === 'list') {
    const Tag = (block.ordered ? 'ol' : 'ul') as ElementType;
    return (
      <Tag>
        {block.items.map((item, index) => <li key={index}>{renderInlineTokens(item.inline, resolveSrc)}</li>)}
      </Tag>
    );
  }
  if (block.type === 'table') {
    return (
      <div className="rich-markdown-table-wrap">
        <table>
          {block.header && (
            <thead>
              <tr>{block.header.map((cell, index) => <th key={index}>{renderInlineTokens(cell, resolveSrc)}</th>)}</tr>
            </thead>
          )}
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => <td key={cellIndex}>{renderInlineTokens(cell, resolveSrc)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.type === 'code') {
    return (
      <pre className="rich-markdown-code">
        <code data-language={block.language || undefined}>{block.text}</code>
      </pre>
    );
  }
  if (block.type === 'math') {
    return <div className="rich-markdown-math">{renderTexMathToText(block.text)}</div>;
  }
  if (block.type === 'image') {
    return (
      <figure className="rich-markdown-figure">
        <img src={resolveSrc(block.src)} alt={block.alt} />
        {block.alt ? <figcaption>{block.alt}</figcaption> : null}
      </figure>
    );
  }
  return null;
}

export function renderInlineTokens(tokens, resolveSrc = null) {
  return (tokens || []).map((token, index) => renderInlineToken(token, index, resolveSrc));
}

function renderInlineToken(token, key, resolveSrc) {
  if (!token) return null;
  if (token.type === 'strong') return <strong key={key}>{token.text}</strong>;
  if (token.type === 'em') return <em key={key}>{token.text}</em>;
  if (token.type === 'code') return <code key={key}>{token.text}</code>;
  if (token.type === 'math') return <span key={key} className="math-inline">{renderTexMathToText(token.text)}</span>;
  if (token.type === 'link') {
    // 链接先不跳转（与源文档视图一致；Electron 内打开外链的行为留到 agent 阶段按需接 window-service）。
    return (
      <a key={key} href={token.href || '#'} onClick={(event) => event.preventDefault()}>
        {token.text}
      </a>
    );
  }
  if (token.type === 'image') {
    return <img key={key} className="rich-markdown-inline-image" src={resolveSrc ? resolveSrc(token.src) : token.src} alt={token.alt || ''} />;
  }
  return <span key={key}>{token.text || ''}</span>;
}

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { syntaxTree } from '@codemirror/language';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import { StateField, type EditorState, type Range } from '@codemirror/state';

const marks: Record<string, string> = {
  StrongEmphasis: 'strong',
  Emphasis: 'emphasis',
  Strikethrough: 'strike',
  InlineCode: 'inline-code',
  Link: 'link',
  Autolink: 'link',
};

function isActive(state: EditorState, from: number, to: number) {
  return (
    !state.readOnly &&
    state.selection.ranges.some(
      (range) =>
        from <= state.doc.lineAt(range.to).to &&
        to >= state.doc.lineAt(range.from).from,
    )
  );
}

class RenderedMarkdown extends WidgetType {
  readonly source: string;
  readonly block: boolean;

  constructor(source: string, block = false) {
    super();
    this.source = source;
    this.block = block;
  }

  eq(other: RenderedMarkdown) {
    return this.source === other.source && this.block === other.block;
  }

  toDOM(view: EditorView) {
    const element: HTMLElement = view.dom.ownerDocument.createElement(
      this.block ? 'div' : 'span',
    );
    element.className = this.block ? 'md-rendered-table' : 'md-rendered-inline';
    const markup = renderToStaticMarkup(
      createElement(ReactMarkdown, {
        remarkPlugins: [remarkGfm],
        skipHtml: true,
        children: this.source,
      }),
    );
    const template = view.dom.ownerDocument.createElement('template');
    template.innerHTML = markup;
    const paragraph = template.content.querySelector('p');
    element.append(
      ...(this.block
        ? template.content.childNodes
        : (paragraph?.childNodes ?? [])),
    );
    const edit = (event: MouseEvent) => {
      if (event.button !== 0 || view.state.readOnly) return;
      event.preventDefault();
      view.dispatch({
        selection: { anchor: view.posAtDOM(element) },
        scrollIntoView: true,
      });
      view.focus();
    };
    element.addEventListener('mousedown', edit);
    if (!this.block) {
      for (const image of element.querySelectorAll('img')) {
        image.loading = 'lazy';
        image.addEventListener('load', () => view.requestMeasure());
      }
    }
    return element;
  }
}

function renderTables(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  syntaxTree(state).iterate({
    enter({ name, from, to }) {
      if (name !== 'Table') return;
      if (!isActive(state, from, to)) {
        ranges.push(
          Decoration.replace({
            block: true,
            widget: new RenderedMarkdown(state.sliceDoc(from, to), true),
          }).range(from, to),
        );
      }
      return false;
    },
  });
  return Decoration.set(ranges, true);
}

const tables = StateField.define<DecorationSet>({
  create: renderTables,
  update(value, transaction) {
    return transaction.docChanged ||
      transaction.selection ||
      transaction.startState.readOnly !== transaction.state.readOnly ||
      syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
      ? renderTables(transaction.state)
      : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

function decorate(view: EditorView): DecorationSet {
  const { state } = view;
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  const processed = new Set<number>();
  for (const visible of view.visibleRanges) {
    tree.iterate({
      ...visible,
      enter(node) {
        const { from, to, name } = node;
        const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
        if (heading && !processed.has(from)) {
          processed.add(from);
          ranges.push(
            Decoration.line({
              class: 'md-heading md-heading-' + heading[1],
              attributes: { role: 'heading', 'aria-level': heading[1] },
            }).range(state.doc.lineAt(from).from),
          );
        }
        if (marks[name])
          ranges.push(
            Decoration.mark({ class: 'md-' + marks[name] }).range(from, to),
          );
        if (name === 'QuoteMark' || name === 'ListMark')
          ranges.push(Decoration.mark({ class: 'md-marker' }).range(from, to));
        if (
          name === 'Blockquote' ||
          name === 'FencedCode' ||
          name === 'CodeBlock'
        ) {
          const className =
            name === 'Blockquote' ? 'md-quote' : 'md-code-block';
          for (
            let line = state.doc.lineAt(Math.max(from, visible.from));
            line.from < to && line.from <= visible.to;
            line = state.doc.line(line.number + 1)
          ) {
            ranges.push(Decoration.line({ class: className }).range(line.from));
            if (line.number === state.doc.lines) break;
          }
        }
        if (isActive(state, from, to)) return;
        if (
          name === 'Image' &&
          node.node.getChild('URL') &&
          to <= state.doc.lineAt(from).to
        ) {
          ranges.push(
            Decoration.replace({
              widget: new RenderedMarkdown(state.sliceDoc(from, to)),
            }).range(from, to),
          );
          return false;
        }
        if (
          /^(HeaderMark|EmphasisMark|StrikethroughMark|CodeMark)$/.test(name)
        ) {
          const line = state.doc.lineAt(from);
          if (
            to <= line.to &&
            (name !== 'CodeMark' || node.matchContext(['InlineCode']))
          ) {
            const end =
              name === 'HeaderMark' &&
              /^\s*$/.test(state.sliceDoc(line.from, from))
                ? to + (state.sliceDoc(to, to + 1) === ' ' ? 1 : 0)
                : to;
            ranges.push(Decoration.replace({}).range(from, end));
          }
        }
        if (name === 'Link' && state.doc.lineAt(from).to >= to) {
          const source = state.sliceDoc(from, to);
          const labelEnd = source.lastIndexOf('](');
          if (labelEnd > 0 && source.endsWith(')')) {
            ranges.push(Decoration.replace({}).range(from, from + 1));
            ranges.push(Decoration.replace({}).range(from + labelEnd, to));
          }
        }
      },
    });
  }
  return Decoration.set(ranges, true);
}

const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorate(view);
    }
    update(update: import('@codemirror/view').ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.startState.readOnly !== update.state.readOnly ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      )
        this.decorations = decorate(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export const markdownLive = [tables, inlinePreview];

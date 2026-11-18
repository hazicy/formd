import * as Y from 'yjs';
import { fromByteArray, toByteArray } from 'base64-js';
import type { RelativeSelection } from '@typo/core';
export function captureSelection(
  text: Y.Text,
  anchor: number,
  head: number,
): RelativeSelection {
  const position = (index: number) =>
    fromByteArray(
      Y.encodeRelativePosition(
        Y.createRelativePositionFromTypeIndex(
          text,
          Math.max(0, Math.min(text.length, index)),
        ),
      ),
    );
  return { anchor: position(anchor), head: position(head) };
}
export function resolveSelection(
  text: Y.Text,
  selection: RelativeSelection | null,
): { anchor: number; head: number } | null {
  if (!selection || !text.doc) return null;
  try {
    const position = (value: string) =>
      Y.createAbsolutePositionFromRelativePosition(
        Y.decodeRelativePosition(toByteArray(value)),
        text.doc!,
      );
    const anchor = position(selection.anchor),
      head = position(selection.head);
    return anchor?.type === text && head?.type === text
      ? { anchor: anchor.index, head: head.index }
      : null;
  } catch {
    return null;
  }
}

import * as Y from 'yjs';
import { fromByteArray, toByteArray } from 'base64-js';
import type { RelativeSelection } from '@formd/core';
function encodePosition(text: Y.Text, index: number, association = 0) {
  return fromByteArray(
    Y.encodeRelativePosition(
      Y.createRelativePositionFromTypeIndex(
        text,
        Math.max(0, Math.min(text.length, index)),
        association,
      ),
    ),
  );
}
export function captureSelection(
  text: Y.Text,
  anchor: number,
  head: number,
): RelativeSelection {
  return {
    anchor: encodePosition(text, anchor),
    head: encodePosition(text, head),
  };
}
export function captureCommentAnchor(
  text: Y.Text,
  start: number,
  end: number,
): RelativeSelection {
  return {
    anchor: encodePosition(text, start),
    head: encodePosition(text, end, start === end ? 0 : -1),
  };
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

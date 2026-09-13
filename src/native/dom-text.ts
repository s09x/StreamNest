interface TextNode {
  readonly type: string;
  readonly data?: string;
  readonly children?: readonly TextNode[];
}

/** DOM textContent semantics without recursive calls into the native JS stack. */
export function domText(nodes: readonly TextNode[]): string {
  const parts: string[] = [];
  const frames: Array<{ nodes: readonly TextNode[]; index: number }> = [{ nodes, index: 0 }];
  while (frames.length) {
    const frame = frames[frames.length - 1]!;
    if (frame.index >= frame.nodes.length) {
      frames.pop();
      continue;
    }
    const node = frame.nodes[frame.index++]!;
    if (node.type === 'comment') continue;
    if (node.type === 'text') parts.push(node.data ?? '');
    else if (node.children?.length) frames.push({ nodes: node.children, index: 0 });
  }
  return parts.join('');
}

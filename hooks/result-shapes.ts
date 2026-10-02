export type TextRewrite = (text: string, keepLineCount: boolean) => Promise<string>;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTextBlock(value: unknown): value is Obj & { text: string } {
  return isObj(value) && value['type'] === 'text' && typeof value['text'] === 'string';
}

async function mapBlocks(blocks: readonly unknown[], rewrite: TextRewrite): Promise<unknown[]> {
  return Promise.all(
    blocks.map(async (block) =>
      isTextBlock(block) ? { ...block, text: await rewrite(block.text, false) } : block,
    ),
  );
}

async function mapMcp(result: unknown, rewrite: TextRewrite): Promise<unknown> {
  if (typeof result === 'string') return rewrite(result, false);
  if (Array.isArray(result)) return mapBlocks(result, rewrite);
  if (isObj(result) && Array.isArray(result['content'])) {
    return { ...result, content: await mapBlocks(result['content'], rewrite) };
  }
  return result;
}

async function mapRead(result: Obj, rewrite: TextRewrite): Promise<unknown> {
  const file = result['file'];
  if (result['type'] !== 'text' || !isObj(file) || typeof file['content'] !== 'string') {
    return result;
  }
  return { ...result, file: { ...file, content: await rewrite(file['content'], true) } };
}

export type ShapeOptions = { read: boolean };

/**
 * Applies `rewrite` to every text a tool's result holds, keeping the result's
 * own shape so the tool's mapper still reads it: Bash `stdout`, a text `Read`'s
 * `file.content` (when enabled), and the strings or text blocks of an MCP tool
 * result. Any other tool or shape comes back as the same object.
 */
export async function mapResultText(
  tool: string,
  result: unknown,
  rewrite: TextRewrite,
  options: ShapeOptions,
): Promise<unknown> {
  if (tool.startsWith('mcp__')) return mapMcp(result, rewrite);
  if (!isObj(result)) return result;
  if (tool === 'Bash' && typeof result['stdout'] === 'string') {
    if (result['isImage'] || result['backgroundTaskId'] || result['persistedOutputPath']) {
      return result;
    }
    return { ...result, stdout: await rewrite(result['stdout'], false) };
  }
  if (tool === 'Read' && options.read) return mapRead(result, rewrite);
  return result;
}

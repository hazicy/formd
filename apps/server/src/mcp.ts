import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  FormdClient,
  MAX_CONTENT_LENGTH,
  isNoteId,
  PRESENCE_COLORS,
} from '@formd/client';
import { z } from 'zod';
import { AgentSession } from './agent-session.js';

const baseUrl = new URL(process.env.FORMD_API_URL || 'http://localhost:3001');
if (!['http:', 'https:'].includes(baseUrl.protocol))
  throw new Error('FORMD_API_URL must use HTTP or HTTPS.');
const client = new FormdClient(baseUrl.href.replace(/\/$/, ''));
const name = process.env.FORMD_AGENT_NAME?.trim().slice(0, 48) || 'Formd Agent';
const sessions = new Map<string, AgentSession>();
const server = new McpServer({ name: 'formd', version: '0.1.0' });
const id = z.string().refine(isNoteId).describe('The Formd document ID.');

function sessionFor(id: string) {
  const previous = sessions.get(id);
  if (previous?.active) return previous;
  const url = new URL(
    client.baseUrl.replace(/^http/, 'ws') + '/sync/' + encodeURIComponent(id),
  );
  const session = new AgentSession(url, {
    name,
    color: PRESENCE_COLORS[3],
    client: 'agent',
  });
  sessions.set(id, session);
  return session;
}

function result(data: object) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: { ...data },
  };
}

server.registerTool(
  'list_documents',
  {
    description:
      'Find Formd documents and their folder IDs. Optionally filter by title.',
    inputSchema: { query: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async ({ query }) => {
    const search = query?.trim().toLowerCase();
    const documents = await client.list();
    return result({
      documents: search
        ? documents.filter((note) => note.title.toLowerCase().includes(search))
        : documents,
    });
  },
);

server.registerTool(
  'read_document',
  {
    description:
      'Open a live document as an Agent collaborator and read the latest Markdown.',
    inputSchema: { id },
  },
  async ({ id }) => result({ id, markdown: await sessionFor(id).read() }),
);

server.registerTool(
  'edit_document',
  {
    description:
      'Replace one unique exact excerpt in a live document. Read first, then use the shortest unambiguous excerpt. To insert, include nearby text in both inputs. An empty excerpt is only allowed in an empty document. On conflict, read again before retrying.',
    inputSchema: {
      id,
      expected: z.string().max(MAX_CONTENT_LENGTH),
      replacement: z.string().max(MAX_CONTENT_LENGTH),
      preview_ms: z
        .number()
        .int()
        .min(0)
        .max(2000)
        .optional()
        .describe(
          'How long to show the original selection before submitting. Defaults to 300 ms; 0 skips preview.',
        ),
    },
  },
  async ({ id, expected, replacement, preview_ms }) => {
    await sessionFor(id).edit(expected, replacement, preview_ms);
    return result({ id, applied: true });
  },
);

server.registerTool(
  'close_document',
  {
    description:
      'Leave the live document and remove the Agent from its online members.',
    inputSchema: { id },
  },
  async ({ id }) => {
    sessions.get(id)?.close();
    sessions.delete(id);
    return result({ id, closed: true });
  },
);

server.server.onclose = () => {
  for (const session of sessions.values()) session.close();
  sessions.clear();
};
await server.connect(new StdioServerTransport());
process.stdin.once('end', () => void server.close());

#!/usr/bin/env node
/**
 * MCP stdio subprocess — spawned by Claude CLI via --permission-prompt-tool.
 *
 * Exposes a single tool `approval_prompt`. When called, it forwards the request
 * to claw-web's internal HTTP endpoint and waits (long-poll style) until the
 * user clicks Allow/Deny in the browser modal.
 *
 * Required env vars (injected by message-sender.js when spawning claude):
 *   CLAW_BRIDGE_URL    — http://127.0.0.1:<port>/internal/approval/request
 *   CLAW_BRIDGE_TOKEN  — shared secret header
 *   CLAW_SESSION_ID    — which claw-web session this subprocess serves
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BRIDGE_URL = process.env.CLAW_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.CLAW_BRIDGE_TOKEN;
const SESSION_ID = process.env.CLAW_SESSION_ID;
// Slightly shorter than the broker-side timeout so the broker always wins on cleanup.
const MCP_SIDE_TIMEOUT_MS = Number(process.env.CLAW_BRIDGE_TIMEOUT_MS || 14 * 60 * 1000);

if (!BRIDGE_URL || !BRIDGE_TOKEN || !SESSION_ID) {
  // Without these, we can't function — emit deny and exit so Claude CLI doesn't hang.
  console.error('[claw-mcp] missing env vars — bridge disabled');
  process.exit(1);
}

const server = new McpServer({ name: 'claw', version: '1.0.0' });

server.registerTool(
  'approval_prompt',
  {
    title: 'Tool-use approval',
    description:
      'Ask the user (via claw-web UI) whether a tool invocation should be allowed. ' +
      'Returns { behavior: "allow", updatedInput } or { behavior: "deny", message }.',
    inputSchema: {
      tool_name: z.string(),
      input: z.object({}).passthrough(),
      tool_use_id: z.string().optional()
    }
  },
  async ({ tool_name, input, tool_use_id }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MCP_SIDE_TIMEOUT_MS);
    let decision;
    try {
      const res = await fetch(BRIDGE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Claw-Bridge-Token': BRIDGE_TOKEN
        },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          toolName: tool_name,
          input,
          toolUseId: tool_use_id ?? null
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        decision = { behavior: 'deny', message: `bridge error ${res.status}: ${txt.slice(0, 200)}` };
      } else {
        decision = await res.json();
      }
    } catch (err) {
      decision = { behavior: 'deny', message: `bridge request failed: ${err?.message || err}` };
    } finally {
      clearTimeout(timer);
    }

    // Claude CLI expects the payload as a JSON-stringified text content.
    // See Anthropic docs for --permission-prompt-tool contract.
    const payload =
      decision.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: decision.updatedInput ?? input }
        : { behavior: 'deny', message: decision.message || 'Denied by user' };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

interface RpcErrorShape {
  code?: number;
  message?: string;
  data?: unknown;
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface ToolCallAttempt {
  label: string;
  args: Record<string, unknown>;
}

export interface ShareMeetingMarkdownInput {
  title: string;
  markdown: string;
}

export interface ShareMeetingMarkdownResult {
  ok: boolean;
  toolName?: string;
  pageId?: string;
  pageUrl?: string;
  message?: string;
}

const REMOTE_NOTION_MCP_URL = 'https://mcp.notion.com/mcp';
const PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'];

export class NotionMcpService {
  private readonly endpoint: string | null;
  private readonly bearerToken: string | null;
  private readonly toolOverride: string | null;
  private readonly defaultParentPageId: string | null;

  constructor() {
    const configuredUrl = String(process.env.NOTION_MCP_URL || '').trim();
    const configuredToken = String(process.env.NOTION_MCP_BEARER_TOKEN || '').trim();
    this.endpoint = configuredUrl || (configuredToken ? REMOTE_NOTION_MCP_URL : null);
    this.bearerToken = configuredToken || null;
    this.toolOverride = String(process.env.NOTION_MCP_CREATE_TOOL || '').trim() || null;
    this.defaultParentPageId = String(process.env.NOTION_PAGE_ID || '').trim() || null;
  }

  isConfigured(): boolean {
    return Boolean(this.endpoint);
  }

  async shareMeetingMarkdown(input: ShareMeetingMarkdownInput): Promise<ShareMeetingMarkdownResult> {
    if (!this.endpoint) {
      return { ok: false, message: 'Notion MCP is not configured' };
    }

    const title = String(input.title || '').trim() || 'Meeting Notes';
    const markdown = String(input.markdown || '').trim();
    if (!markdown) {
      return { ok: false, message: 'No markdown content to share' };
    }

    try {
      const sessionId = await this.initializeSession();
      const tools = await this.listTools(sessionId);
      const selectedTool = this.selectCreateTool(tools);

      if (!selectedTool) {
        return {
          ok: false,
          message: 'Connected to Notion MCP, but no supported page-creation tool was found',
        };
      }

      const attempts = this.buildToolAttempts(selectedTool, { title, markdown });
      if (attempts.length === 0) {
        return {
          ok: false,
          toolName: selectedTool.name,
          message: 'No compatible payload could be built for Notion MCP create-page tool',
        };
      }

      let lastError = '';
      for (const attempt of attempts) {
        try {
          const result = await this.callTool(sessionId, selectedTool.name, attempt.args);
          const parsed = this.extractPageInfo(result);
          return {
            ok: true,
            toolName: selectedTool.name,
            pageId: parsed.pageId,
            pageUrl: parsed.pageUrl,
            message: parsed.pageId
              ? `Created Notion page (${parsed.pageId}) via ${selectedTool.name}`
              : `Shared to Notion via ${selectedTool.name}`,
          };
        } catch (err) {
          lastError = `${attempt.label}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      return {
        ok: false,
        toolName: selectedTool.name,
        message: lastError || 'Notion MCP rejected all page-creation payload attempts',
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async initializeSession(): Promise<string | null> {
    let lastError: Error | null = null;

    for (const protocolVersion of PROTOCOL_VERSIONS) {
      try {
        const initialize = await this.sendJsonRpcRequest(
          'initialize',
          {
            protocolVersion,
            capabilities: {},
            clientInfo: {
              name: 'koe',
              version: '1.0.0',
            },
          },
          null,
          `init-${protocolVersion}`,
          15000,
        );

        await this.sendJsonRpcNotification('notifications/initialized', {}, initialize.sessionId, 8000);
        return initialize.sessionId;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError || new Error('Unable to initialize Notion MCP session');
  }

  private async listTools(sessionId: string | null): Promise<McpToolDescriptor[]> {
    const response = await this.sendJsonRpcRequest('tools/list', {}, sessionId, 'tools-list', 12000);
    const responseObject = this.asObject(response.result);
    const toolsRaw = Array.isArray(responseObject?.tools) ? responseObject.tools : [];

    return toolsRaw
      .map((item) => this.asObject(item))
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item.name === 'string'))
      .map((item) => ({
        name: String(item.name),
        description: typeof item.description === 'string' ? item.description : undefined,
        inputSchema: this.asObject(item.inputSchema) || undefined,
      }));
  }

  private selectCreateTool(tools: McpToolDescriptor[]): McpToolDescriptor | null {
    if (tools.length === 0) {
      return null;
    }

    if (this.toolOverride) {
      const overridden = tools.find((tool) => tool.name === this.toolOverride);
      if (overridden) {
        return overridden;
      }
    }

    const preferred = [
      'notion-create-pages',
      'notion_pages',
      'create_page',
      'notion_create_pages',
      'notion-create-page',
    ];

    for (const name of preferred) {
      const found = tools.find((tool) => tool.name === name);
      if (found) {
        return found;
      }
    }

    const fuzzy = tools.find((tool) => {
      const lower = tool.name.toLowerCase();
      return lower.includes('notion') && lower.includes('create') && lower.includes('page');
    });
    if (fuzzy) {
      return fuzzy;
    }

    return null;
  }

  private buildToolAttempts(tool: McpToolDescriptor, input: ShareMeetingMarkdownInput): ToolCallAttempt[] {
    const attempts: ToolCallAttempt[] = [];
    const unique = new Set<string>();
    const addAttempt = (label: string, args: Record<string, unknown>) => {
      const key = JSON.stringify(args);
      if (unique.has(key)) {
        return;
      }
      unique.add(key);
      attempts.push({ label, args });
    };

    const properties = this.getInputSchemaProperties(tool.inputSchema);
    const lowerName = tool.name.toLowerCase();
    const pageChildren = this.markdownToNotionParagraphBlocks(input.markdown);
    const createPageParams = this.buildCreatePageParams(input.title, pageChildren);

    if (lowerName === 'notion_pages') {
      addAttempt('notion_pages:create_page', {
        payload: {
          action: 'create_page',
          params: createPageParams,
        },
      });
    }

    if (lowerName === 'create_page') {
      addAttempt('create_page:direct', createPageParams);
    }

    if (lowerName.includes('create-pages') || lowerName.includes('create_pages') || lowerName.includes('create-page')) {
      const pageEntryBase: Record<string, unknown> = {
        title: input.title,
        content: input.markdown,
      };
      if (this.defaultParentPageId) {
        pageEntryBase.parent = { type: 'page_id', page_id: this.defaultParentPageId };
      }

      addAttempt('notion-create-pages:pages-title-content', {
        pages: [pageEntryBase],
      });
      addAttempt('notion-create-pages:pages-title-markdown', {
        pages: [{ ...pageEntryBase, markdown: input.markdown }],
      });
      addAttempt('notion-create-pages:single-title-content', {
        title: input.title,
        content: input.markdown,
      });
      addAttempt('notion-create-pages:single-title-markdown', {
        title: input.title,
        markdown: input.markdown,
      });
    }

    if (properties.has('payload') && properties.has('params')) {
      addAttempt('schema:payload-action-create_page', {
        payload: {
          action: 'create_page',
          params: createPageParams,
        },
      });
    }

    if (properties.has('payload')) {
      addAttempt('schema:payload-create_page', {
        payload: {
          action: 'create_page',
          params: createPageParams,
        },
      });
    }

    if (properties.has('pages')) {
      addAttempt('schema:pages-array', {
        pages: [
          {
            title: input.title,
            content: input.markdown,
          },
        ],
      });
    }

    if (properties.has('properties') || properties.has('children')) {
      addAttempt('schema:create-page-like', createPageParams);
    }

    addAttempt('fallback:create-page-like', createPageParams);
    addAttempt('fallback:title-content', {
      title: input.title,
      content: input.markdown,
    });

    return attempts;
  }

  private buildCreatePageParams(title: string, children: Array<Record<string, unknown>>): Record<string, unknown> {
    const params: Record<string, unknown> = {
      properties: {
        title: {
          title: [{ text: { content: title.slice(0, 200) } }],
        },
      },
    };

    if (children.length > 0) {
      params.children = children;
    }

    if (this.defaultParentPageId) {
      params.parent = {
        type: 'page_id',
        page_id: this.defaultParentPageId,
      };
    }

    return params;
  }

  private markdownToNotionParagraphBlocks(markdown: string): Array<Record<string, unknown>> {
    const paragraphs = String(markdown || '')
      .split(/\r?\n\s*\r?\n/)
      .map((entry) => entry.replace(/\r?\n/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 80);

    return paragraphs.map((paragraph) => ({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: paragraph.slice(0, 1900),
            },
          },
        ],
      },
    }));
  }

  private getInputSchemaProperties(schema: Record<string, unknown> | undefined): Set<string> {
    const schemaObject = this.asObject(schema);
    const properties = this.asObject(schemaObject?.properties);
    return new Set(Object.keys(properties || {}));
  }

  private async callTool(
    sessionId: string | null,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.sendJsonRpcRequest(
      'tools/call',
      {
        name: toolName,
        arguments: args,
      },
      sessionId,
      `tools-call-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      30000,
    );

    const resultObject = this.asObject(response.result);
    if (resultObject?.isError === true) {
      throw new Error(this.extractToolErrorMessage(resultObject) || 'Notion MCP tool returned an error');
    }

    return response.result;
  }

  private extractToolErrorMessage(result: Record<string, unknown>): string | null {
    const errorObject = this.asObject(result.error);
    if (errorObject?.message && typeof errorObject.message === 'string') {
      return errorObject.message;
    }

    const content = Array.isArray(result.content) ? result.content : [];
    for (const entry of content) {
      const item = this.asObject(entry);
      if (!item) {
        continue;
      }
      if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
        return item.text.trim();
      }
    }

    return null;
  }

  private extractPageInfo(result: unknown): { pageId?: string; pageUrl?: string } {
    const root = this.asObject(result) || {};
    const content = Array.isArray(root.content) ? root.content : [];
    const textParts: string[] = [];

    for (const entry of content) {
      const item = this.asObject(entry);
      if (!item) {
        continue;
      }
      if (item.type === 'text' && typeof item.text === 'string') {
        textParts.push(item.text);
      }
    }

    const structuredContent = this.asObject(root.structuredContent) || this.asObject(root.data) || root;
    const structuredUrl =
      this.findStringByKey(structuredContent, new Set(['pageUrl', 'page_url', 'url', 'notionUrl'])) || null;
    const structuredId = this.findStringByKey(structuredContent, new Set(['pageId', 'page_id', 'id'])) || null;

    const combinedText = textParts.join('\n').trim();
    const fallbackSearchText = `${combinedText}\n${JSON.stringify(structuredContent)}`;
    const urlMatch = fallbackSearchText.match(/https?:\/\/[^\s)"'<>]+/i);
    const idMatch = fallbackSearchText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

    return {
      pageUrl: structuredUrl || (urlMatch ? urlMatch[0] : undefined),
      pageId: structuredId || (idMatch ? idMatch[0] : undefined),
    };
  }

  private findStringByKey(
    value: unknown,
    keys: Set<string>,
    depth: number = 0,
  ): string | null {
    if (depth > 6 || value === null || value === undefined) {
      return null;
    }

    if (typeof value === 'string') {
      return null;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = this.findStringByKey(item, keys, depth + 1);
        if (nested) {
          return nested;
        }
      }
      return null;
    }

    if (typeof value === 'object') {
      for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (keys.has(key) && typeof nestedValue === 'string' && nestedValue.trim()) {
          return nestedValue.trim();
        }
        const nested = this.findStringByKey(nestedValue, keys, depth + 1);
        if (nested) {
          return nested;
        }
      }
    }

    return null;
  }

  private async sendJsonRpcRequest(
    method: string,
    params: unknown,
    sessionId: string | null,
    id: string,
    timeoutMs: number,
  ): Promise<{ result: unknown; sessionId: string | null }> {
    const requestBody: Record<string, unknown> = {
      jsonrpc: '2.0',
      id,
      method,
    };
    if (params !== undefined) {
      requestBody.params = params;
    }

    const response = await this.postRpcRequest(requestBody, sessionId, timeoutMs);
    const envelope = this.asObject(response.payload);

    if (!envelope) {
      throw new Error(`Invalid JSON-RPC response from Notion MCP for ${method}`);
    }
    if (envelope.error) {
      throw new Error(this.formatRpcError(envelope.error));
    }
    if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
      throw new Error(`JSON-RPC response for ${method} did not include a result`);
    }

    return {
      result: envelope.result,
      sessionId: response.sessionId,
    };
  }

  private async sendJsonRpcNotification(
    method: string,
    params: unknown,
    sessionId: string | null,
    timeoutMs: number,
  ): Promise<void> {
    const notificationBody: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
    };
    if (params !== undefined) {
      notificationBody.params = params;
    }

    await this.postRpcRequest(notificationBody, sessionId, timeoutMs);
  }

  private async postRpcRequest(
    body: Record<string, unknown>,
    sessionId: string | null,
    timeoutMs: number,
  ): Promise<{ payload: unknown; sessionId: string | null }> {
    if (!this.endpoint) {
      throw new Error('Notion MCP endpoint is missing');
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (sessionId) {
      headers['mcp-session-id'] = sessionId;
    }
    if (this.bearerToken) {
      headers.authorization = `Bearer ${this.bearerToken}`;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const nextSessionId = response.headers.get('mcp-session-id') || sessionId || null;
      const raw = await response.text();
      if (!response.ok) {
        const suffix = raw.trim() ? `: ${raw.trim().slice(0, 280)}` : '';
        throw new Error(`Notion MCP request failed (${response.status})${suffix}`);
      }

      const payload = this.parseRpcPayload(raw, response.headers.get('content-type'));
      return {
        payload,
        sessionId: nextSessionId,
      };
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`Notion MCP request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private parseRpcPayload(raw: string, contentType: string | null): unknown {
    const text = String(raw || '').trim();
    if (!text) {
      return null;
    }

    if ((contentType || '').includes('text/event-stream')) {
      const eventPayload = this.extractLastEventDataPayload(text);
      if (eventPayload) {
        return this.safeParseJson(eventPayload);
      }
    }

    try {
      return this.safeParseJson(text);
    } catch {
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          return this.safeParseJson(lines[i]);
        } catch {
          continue;
        }
      }
      throw new Error('Unable to parse Notion MCP response payload');
    }
  }

  private extractLastEventDataPayload(raw: string): string | null {
    const blocks = raw.split(/\r?\n\r?\n/);
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const dataLines = blocks[i]
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim());
      if (dataLines.length === 0) {
        continue;
      }
      const joined = dataLines.join('\n').trim();
      if (joined && joined !== '[DONE]') {
        return joined;
      }
    }
    return null;
  }

  private safeParseJson(value: string): unknown {
    return JSON.parse(value) as unknown;
  }

  private formatRpcError(error: unknown): string {
    const rpcError = this.asObject(error) as RpcErrorShape | null;
    if (!rpcError) {
      return `Notion MCP returned an unknown error: ${String(error)}`;
    }

    const code = typeof rpcError.code === 'number' ? rpcError.code : undefined;
    const message = typeof rpcError.message === 'string' ? rpcError.message : 'Unknown RPC error';
    const data = rpcError.data === undefined ? '' : ` | data=${JSON.stringify(rpcError.data)}`;
    return `Notion MCP RPC error${code !== undefined ? ` ${code}` : ''}: ${message}${data}`;
  }

  private asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }
}

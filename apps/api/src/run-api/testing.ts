// Test support for the run API: a minimal SSE client over fetch. Imported only by tests.

export interface SseMessage {
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly data: string | undefined;
  /** A comment-only block (`: ping`). */
  readonly comment: boolean;
  readonly retry: string | undefined;
}

/** Splits an event-stream body into complete messages (the trailing partial block is ignored). */
export function parseSse(text: string): SseMessage[] {
  const blocks = text.split('\n\n');
  blocks.pop();
  return blocks.map((block) => {
    const fields = new Map<string, string>();
    let comment = false;
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        comment = true;
        continue;
      }
      const colon = line.indexOf(':');
      const name = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      fields.set(name, value);
    }
    return {
      id: fields.get('id'),
      event: fields.get('event'),
      data: fields.get('data'),
      comment: comment && fields.size === 0,
      retry: fields.get('retry'),
    };
  });
}

export interface SseConnection {
  readonly status: number;
  readonly headers: Headers;
  /** Everything received so far. */
  text(): string;
  messages(): SseMessage[];
  /** Reads until `predicate` holds for the received text; rejects on timeout or a closed stream. */
  until(predicate: (messages: SseMessage[]) => boolean, timeoutMs?: number): Promise<void>;
  /** Resolves when the server ends the stream (rejects on timeout). */
  closed(timeoutMs?: number): Promise<void>;
  abort(): void;
}

export async function openSse(
  url: string,
  headers: Record<string, string> = {},
): Promise<SseConnection> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  let received = '';
  let done = false;
  const body = response.body;
  if (body === null) throw new Error('The response has no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending: Promise<void> | undefined;

  function pump(): Promise<void> {
    pending ??= reader.read().then(
      (chunk) => {
        pending = undefined;
        const value: unknown = chunk.value;
        if (chunk.done) done = true;
        else if (value instanceof Uint8Array) received += decoder.decode(value, { stream: true });
        else throw new TypeError('Expected a byte stream');
      },
      () => {
        pending = undefined;
        done = true;
      },
    );
    return pending;
  }

  async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (done) throw new Error(`Stream closed before ${what}; received: ${received}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${what}; received: ${received}`);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        pump(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, remaining);
        }),
      ]);
      clearTimeout(timer);
    }
  }

  return {
    status: response.status,
    headers: response.headers,
    text: () => received,
    messages: () => parseSse(received),
    until: (predicate, timeoutMs = 3000) =>
      waitFor(() => predicate(parseSse(received)), timeoutMs, 'the expected messages'),
    async closed(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (!done) {
        if (Date.now() > deadline) throw new Error('The stream did not close');
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          pump(),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, deadline - Date.now());
          }),
        ]);
        clearTimeout(timer);
      }
    },
    abort: () => {
      controller.abort();
    },
  };
}

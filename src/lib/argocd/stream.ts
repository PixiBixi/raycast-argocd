/**
 * Incremental extraction of the elements of one top-level JSON array, so a list response is
 * never materialised whole.
 *
 * This exists because of a hard limit, not a preference: a Raycast command gets a 100 MB JS
 * heap. One applications list is 30.2 MB of compact JSON, which becomes roughly 60 MB as a
 * UTF-16 JavaScript string plus another 50 MB of object graph once parsed. `response.json()`
 * holds both at once, so a single instance blows the limit and two in parallel do so twice
 * over. Measured, not estimated: that is the payload of a real instance holding 2053
 * applications.
 *
 * So the body is consumed as a stream, each element of `items` is parsed on its own, projected
 * to the row model, and dropped. Peak memory becomes one element plus the projection, which is
 * 1.5 MB for the same instance.
 *
 * The scanner is deliberately narrow. It does not parse JSON: it finds the named array and then
 * tracks brace and bracket depth, string state and escapes to know where each element ends,
 * handing that slice to `JSON.parse`. That is enough for an object-or-array element list and
 * small enough to test exhaustively, which a general streaming parser would not be.
 */

const QUOTE = 0x22;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;

/** JSON insignificant whitespace: space, tab, line feed, carriage return. */
function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * A 200 that is not the expected list: the array never opened (an HTML page from a proxy or a
 * captive portal) or never closed (a body cut short). Caching either as a valid list would show
 * an empty or partial instance for the whole cache lifetime with no error.
 */
export class MalformedListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedListError";
  }
}

interface ScanState {
  /** Start of the current element carried over from previous chunks, empty when between elements. */
  pending: string;
  /** True while an element is being accumulated, even if nothing is pending yet. */
  inElement: boolean;
  depth: number;
  inString: boolean;
  escaped: boolean;
  /** True once the opening bracket of the target array has been consumed. */
  inArray: boolean;
  /** True once the array has been closed (or was null), after which everything is ignored. */
  done: boolean;
  /** Text not yet searched for the array key, kept bounded. */
  prelude: string;
}

function initialState(): ScanState {
  return {
    pending: "",
    inElement: false,
    depth: 0,
    inString: false,
    escaped: false,
    inArray: false,
    done: false,
    prelude: "",
  };
}

/**
 * Finds `"<key>"` followed by a colon and an opening bracket. Returns the index just after the
 * bracket, or -1. Scanning the raw text is safe here because the key is matched with its quotes
 * and colon, and a value containing that exact sequence would have to be a JSON string holding
 * `"items":[`, which no ArgoCD field does.
 */
function findArrayStart(text: string, key: string): number {
  const needle = `"${key}"`;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) {
      return -1;
    }
    let index = at + needle.length;
    while (index < text.length && isWhitespace(text.charCodeAt(index))) index++;
    if (text[index] === ":") {
      index++;
      while (index < text.length && isWhitespace(text.charCodeAt(index))) index++;
      if (text[index] === "[") {
        return index + 1;
      }
      // `"items": null` is a valid empty answer, and there is nothing after it to stream.
      if (text.startsWith("null", index)) {
        return -2;
      }
    }
    from = at + needle.length;
  }
}

/** Keeps the unsearched prelude bounded while still allowing the key to straddle chunks. */
const PRELUDE_TAIL = 64;

function feed(state: ScanState, chunk: string, key: string, out: unknown[]): void {
  if (state.done) {
    return;
  }

  let text = chunk;

  if (!state.inArray) {
    const combined = state.prelude + text;
    const start = findArrayStart(combined, key);
    if (start === -2) {
      state.done = true;
      return;
    }
    if (start === -1) {
      state.prelude = combined.slice(-PRELUDE_TAIL);
      return;
    }
    state.inArray = true;
    state.prelude = "";
    text = combined.slice(start);
  }

  // Elements are cut out with slice() rather than built a character at a time: string
  // concatenation per character was the bulk of the scan time on a large list.
  const length = text.length;
  let elementStart = state.inElement ? 0 : -1;
  // Cached position of the next backslash, so skipping a string stays linear.
  let nextBackslash = -1;
  let index = 0;

  const emit = (end: number) => {
    const piece = elementStart === -1 ? "" : text.slice(elementStart, end);
    flush(state.pending + piece, out);
    state.pending = "";
    state.inElement = false;
    elementStart = -1;
  };

  while (index < length) {
    if (state.inString) {
      if (state.escaped) {
        state.escaped = false;
        index++;
        continue;
      }
      const quote = text.indexOf('"', index);
      if (nextBackslash !== -2 && nextBackslash < index) {
        const found = text.indexOf("\\", index);
        nextBackslash = found === -1 ? -2 : found;
      }
      if (nextBackslash >= 0 && (quote === -1 || nextBackslash < quote)) {
        state.escaped = true;
        index = nextBackslash + 1;
        continue;
      }
      if (quote === -1) {
        index = length;
        break;
      }
      state.inString = false;
      index = quote + 1;
      continue;
    }

    const code = text.charCodeAt(index);

    if (code === QUOTE) {
      state.inString = true;
    } else if (code === OPEN_BRACE || code === OPEN_BRACKET) {
      state.depth++;
    } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
      if (state.depth === 0) {
        // The closing bracket of the target array.
        if (state.inElement) {
          emit(index);
        }
        state.done = true;
        return;
      }
      state.depth--;
      if (state.depth === 0) {
        emit(index + 1);
        index++;
        continue;
      }
    } else if (state.depth === 0) {
      if (code === COMMA) {
        // A complete object or array was flushed by its closing bracket; anything left here is
        // a scalar element.
        if (state.inElement) {
          emit(index);
        }
        index++;
        continue;
      }
      if (isWhitespace(code)) {
        index++;
        continue;
      }
    }

    if (!state.inElement) {
      state.inElement = true;
      elementStart = index;
    }
    index++;
  }

  if (state.inElement) {
    state.pending += text.slice(elementStart === -1 ? 0 : elementStart);
  }
}

function flush(raw: string, out: unknown[]): void {
  const text = raw.trim();
  if (text.length === 0) {
    return;
  }
  try {
    out.push(JSON.parse(text));
  } catch {
    // A single unparseable element is dropped rather than taking the whole list down, the same
    // way the projection drops an element it cannot identify.
  }
}

export interface StreamArrayOptions {
  /** Name of the top-level array to extract. */
  key: string;
  /**
   * False for an endpoint that omits the array when it is empty. When true (the default), a
   * body without it is a MalformedListError. A truncated array is one either way.
   */
  required?: boolean;
  /** Called with each parsed element. Return value ignored; throwing aborts the scan. */
  onItem: (item: unknown) => void;
}

/**
 * Consumes an async iterable of decoded text chunks and calls `onItem` for each element of the
 * named array. Chunk boundaries may fall anywhere, including inside a string or a key.
 */
export async function streamArrayItems(chunks: AsyncIterable<string>, options: StreamArrayOptions): Promise<void> {
  const state = initialState();
  const batch: unknown[] = [];

  for await (const chunk of chunks) {
    feed(state, chunk, options.key, batch);
    // Drained after every chunk so nothing accumulates beyond one chunk's worth of elements.
    for (const item of batch) {
      options.onItem(item);
    }
    batch.length = 0;
    if (state.done) {
      return;
    }
  }

  if (state.inArray) {
    throw new MalformedListError(`The "${options.key}" array ended before it was closed.`);
  }
  if (options.required ?? true) {
    throw new MalformedListError(`The response carries no "${options.key}" array.`);
  }
}

/** Splits a whole string, for tests and for callers that already hold the text. */
export function collectArrayItems(text: string, key: string): unknown[] {
  const state = initialState();
  const out: unknown[] = [];
  feed(state, text, key, out);
  return out;
}

/** Decodes a byte stream to text chunks without ever concatenating the whole body. */
export async function* decodeStream(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  const iterable = Symbol.asyncIterator in stream ? (stream as AsyncIterable<Uint8Array>) : toIterable(stream);
  for await (const bytes of iterable) {
    // stream: true so a multi-byte character split across chunks is not mangled.
    yield decoder.decode(bytes, { stream: true });
  }
  const tail = decoder.decode();
  if (tail.length > 0) {
    yield tail;
  }
}

async function* toIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

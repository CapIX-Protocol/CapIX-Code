/**
 * Codebase index + context retrieval — the agent brain's local codebase memory.
 *
 * - `CodebaseIndexer`: parses the project into a symbol + import graph.
 * - `ContextRetriever`: selects the most relevant files/symbols for a request.
 *
 * No external dependencies — only Node.js built-ins.
 */

export { CodebaseIndexer } from './indexer.js';
export type {
  SymbolNode,
  ImportEdge,
  FileIndex,
  CodebaseIndex,
} from './indexer.js';

export { ContextRetriever } from './retriever.js';
export type {
  RetrievalResult,
  RetrievedFile,
  RetrievedSymbol,
  RetrievalSource,
} from './retriever.js';

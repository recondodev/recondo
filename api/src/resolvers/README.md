# API Resolvers — Architecture Note

Every resolver in this directory is a thin transport adapter over
`@recondo/data`. The data-layer functions return `AsyncIterable<T>` (for
list-shape reads) or `Promise<T | null>` (for single-record reads).
Resolvers shape the return value into the GraphQL schema's expected
shape and translate `DataValidationError` into `GraphQLError`.

## Why AsyncIterable?

Per the streaming-prep commitments, the data layer is shaped for v1.5
streaming *now* even though v1 ships polling-only. GraphQL has no
`@defer` / `@stream` directives in our stack, so we materialize:

```ts
import { searchTurns } from "@recondo/data";

const searchResolver: NonNullable<QueryResolvers["search"]> = async (
  _parent, args, ctx,
) => {
  // Materialize the AsyncIterable into an array for GraphQL.
  const rows: unknown[] = [];
  for await (const row of searchTurns(ctx.apiKey, args.query, args.projectId ?? null, { limit: 100 })) {
    rows.push(row);
  }
  return rows;
};
```

v1 cost is ~zero (`for await` over an in-memory generator is one
function-call deeper than a direct return). v1.5 streaming consumers
(MCP) chunk the same iterable into progress notifications.

## AbortSignal

`ctx` does not carry a per-request `AbortSignal` from Apollo Server v4
in our setup. Pass `{}` (no signal) for now; threading is a v1.5
follow-up. The Fastify HTTP route at `api/src/query/builder.ts` *does*
thread `req.raw.on("close")` → `AbortController.abort()` → data layer.

## Error conversion

When a `@recondo/data` function throws `DataValidationError`, the
resolver MUST convert it to `GraphQLError`:

```ts
try {
  return await listSessions(ctx.apiKey, filter, options);
} catch (err) {
  if (err instanceof DataValidationError) {
    throw new GraphQLError(err.message, { extensions: { code: err.code } });
  }
  throw err;
}
```

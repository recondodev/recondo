import type { CodegenConfig } from "@graphql-codegen/cli";

const config: CodegenConfig = {
  schema: "src/schema.graphql",
  generates: {
    "src/generated/graphql.ts": {
      plugins: [
        "typescript",
        "typescript-resolvers",
      ],
      config: {
        useIndexSignature: true,
        contextType: "../context.js#GqlContext",
        // B1: Map GraphQL types to our mapper return types.
        // This tells codegen that when a resolver returns a Session, it
        // actually returns a MappedSession (which doesn't include nested
        // resolver fields like `turns`). The nested fields are resolved
        // by their own resolver functions, not the parent mapper.
        mappers: {
          Session: "../resolvers/mappers.js#MappedSession",
          Turn: "../resolvers/mappers.js#MappedTurn",
          ToolCall: "../resolvers/mappers.js#MappedToolCall",
          AnomalyEvent: "../resolvers/mappers.js#MappedAnomaly",
          UserTurn: "../resolvers/mappers.js#MappedUserTurn",
          Attachment: "../resolvers/mappers.js#MappedAttachment",
        },
      },
    },
  },
};

export default config;

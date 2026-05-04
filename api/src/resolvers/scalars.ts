/**
 * Custom GraphQL scalar resolvers.
 *
 * B2 fix: DateTime scalar that serializes as ISO 8601 string and
 * accepts ISO 8601 strings or Date objects as input.
 */

import { GraphQLScalarType, Kind } from "graphql";

/**
 * DateTime scalar type for GraphQL.
 *
 * - **Serialize** (DB/resolver -> client): converts Date objects to ISO strings,
 *   passes strings through unchanged.
 * - **ParseValue** (client variable -> resolver): accepts ISO 8601 strings,
 *   returns them as-is for use in SQL queries.
 * - **ParseLiteral** (inline query value -> resolver): accepts StringValue AST
 *   nodes, returns the string value.
 */
export const DateTimeScalar = new GraphQLScalarType({
  name: "DateTime",
  description:
    "ISO 8601 date-time string (e.g., 2026-03-22T12:00:00.000Z). " +
    "Serialized as a string, accepted as a string or Date.",

  // Resolver -> client: ensure output is always an ISO string
  serialize(value: unknown): string {
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (typeof value === "string") {
      return value;
    }
    throw new TypeError(
      `DateTime scalar serialize: expected string or Date, got ${typeof value}`
    );
  },

  // Client variable -> resolver: accept ISO strings
  parseValue(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    throw new TypeError(
      `DateTime scalar parseValue: expected string, got ${typeof value}`
    );
  },

  // Inline query literal -> resolver: accept string AST nodes
  parseLiteral(ast): string {
    if (ast.kind === Kind.STRING) {
      return ast.value;
    }
    throw new TypeError(
      `DateTime scalar parseLiteral: expected StringValue, got ${ast.kind}`
    );
  },
});

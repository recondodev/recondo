/**
 * Resolver barrel file — D0.5 resolver domain splitting.
 *
 * Deep-merges session, turn, anomaly, realtime, audit, cost, agent,
 * and compliance resolvers into a single resolvers object that Apollo
 * Server can consume.
 *
 * B1 fix: Imports generated `Resolvers` type from codegen output and
 * types the exported `resolvers` object against it. This connects
 * codegen to the resolvers so schema drift produces compile errors.
 *
 * D4: Added audit and cost resolvers.
 * D5: Added agent analytics and compliance resolvers.
 */

import type { Resolvers } from "../generated/graphql.js";
import { sessionResolvers } from "./sessions.js";
import { turnResolvers } from "./turns.js";
import { anomalyResolvers } from "./anomalies.js";
import { realtimeResolvers } from "./realtime.js";
import { auditResolvers } from "./audit.js";
import { costResolvers } from "./cost.js";
import { agentResolvers } from "./agents.js";
import { complianceResolvers } from "./compliance.js";
import { reportResolvers } from "./reports.js";
import { policyResolvers } from "./policies.js";
import { keyResolvers } from "./keys.js";
import { DateTimeScalar } from "./scalars.js";

// B1: Type the merged resolver object against generated `Resolvers` type.
// Schema drift (e.g., renaming a field in schema.graphql without updating
// the resolver) will now produce a compile-time error.
export const resolvers: Resolvers = {
  // B2: DateTime scalar resolver for proper serialization/parsing
  DateTime: DateTimeScalar,
  Query: {
    ...sessionResolvers.Query,
    ...turnResolvers.Query,
    ...anomalyResolvers.Query,
    ...realtimeResolvers.Query,
    ...auditResolvers.Query,
    ...costResolvers.Query,
    ...agentResolvers.Query,
    ...complianceResolvers.Query,
    ...reportResolvers.Query,
    ...policyResolvers.Query,
    ...keyResolvers.Query,
  },
  Mutation: {
    ...complianceResolvers.Mutation,
    ...reportResolvers.Mutation,
    ...policyResolvers.Mutation,
    ...keyResolvers.Mutation,
  },
  Session: {
    ...sessionResolvers.Session,
  },
  UserTurn: {
    ...sessionResolvers.UserTurn,
  },
  Turn: {
    ...turnResolvers.Turn,
  },
  AnomalyEvent: {
    ...anomalyResolvers.AnomalyEvent,
  },
};

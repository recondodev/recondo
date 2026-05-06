// DEPRECATED: Compatibility shim — real implementation lives in @recondo/data.
// New code should import from "@recondo/data" directly.
export {
  mapSession,
  mapTurn,
  mapToolCall,
  mapAnomaly,
  escapeIlike,
  formatTimestamp,
} from "@recondo/data";
export type {
  MappedSession,
  MappedUserTurn,
  MappedAttachment,
  MappedTurn,
  MappedToolCall,
  MappedAnomaly,
} from "@recondo/data";

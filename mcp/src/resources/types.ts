/**
 * Resource-catalog type vocabulary (D-C12-7).
 *
 * Each resource definition carries the URI template + a `read`
 * callback that the SDK invokes for `resources/read`. The catalog
 * unit test exercises the shape directly; the integration test
 * drives the SDK over stdio to validate the wire path end-to-end.
 *
 * Resources differ from tools in that they are addressed by URI, not
 * by name. The SDK uses the `uriTemplate` (RFC 6570) to match incoming
 * `resources/read` calls; the variables (`{id}` etc.) are surfaced to
 * the read callback through the SDK's `Variables` argument.
 */

import type { ToolContext } from "../registry/types.js";

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface ResourceReadResult {
  contents: ResourceContent[];
  isError?: boolean;
}

export interface ResourceDefinition {
  /** RFC 6570 template, e.g. `recondo://session/{id}`. */
  uriTemplate: string;
  /** Stable, human-readable resource catalog name. */
  name: string;
  description: string;
  /** Optional MIME hint for the SDK metadata. */
  mimeType?: string;
  read(uri: string, ctx: ToolContext): Promise<ResourceReadResult>;
}

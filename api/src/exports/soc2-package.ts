/**
 * Sprint 9 Deliverable 7: SOC 2 ZIP+PDF Export
 *
 * POST /v1/exports/soc2/package
 *
 * Calls the existing SOC 2 export logic (handleSoc2Export), then wraps the
 * evidence JSON output into a ZIP file containing:
 * - evidence.json — the full SOC 2 evidence JSON
 * - summary.txt — human-readable text summary
 *
 * ZIP is built in-memory using raw PK headers (no external dependencies).
 */

import { handleSoc2Export } from "./soc2.js";
import type { ApiKeyInfo } from "../context.js";

/**
 * Build a minimal ZIP file in-memory containing the given entries.
 * Each entry is { name: string, data: Buffer }.
 * Returns a Buffer containing a valid ZIP file.
 */
function buildZipBuffer(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf-8");
    const data = entry.data;

    // CRC-32 calculation
    const crc = crc32(data);

    // Local file header (30 bytes + name + data)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);  // Local file header signature
    localHeader.writeUInt16LE(20, 4);           // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0, 6);            // General purpose bit flag
    localHeader.writeUInt16LE(0, 8);            // Compression method (0 = stored)
    localHeader.writeUInt16LE(0, 10);           // Last mod file time
    localHeader.writeUInt16LE(0, 12);           // Last mod file date
    localHeader.writeUInt32LE(crc, 14);         // CRC-32
    localHeader.writeUInt32LE(data.length, 18); // Compressed size
    localHeader.writeUInt32LE(data.length, 22); // Uncompressed size
    localHeader.writeUInt16LE(nameBuffer.length, 26); // File name length
    localHeader.writeUInt16LE(0, 28);           // Extra field length

    const localEntry = Buffer.concat([localHeader, nameBuffer, data]);
    localHeaders.push(localEntry);

    // Central directory header (46 bytes + name)
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);  // Central directory file header signature
    centralHeader.writeUInt16LE(20, 4);           // Version made by
    centralHeader.writeUInt16LE(20, 6);           // Version needed to extract
    centralHeader.writeUInt16LE(0, 8);            // General purpose bit flag
    centralHeader.writeUInt16LE(0, 10);           // Compression method
    centralHeader.writeUInt16LE(0, 12);           // Last mod file time
    centralHeader.writeUInt16LE(0, 14);           // Last mod file date
    centralHeader.writeUInt32LE(crc, 16);         // CRC-32
    centralHeader.writeUInt32LE(data.length, 20); // Compressed size
    centralHeader.writeUInt32LE(data.length, 24); // Uncompressed size
    centralHeader.writeUInt16LE(nameBuffer.length, 28); // File name length
    centralHeader.writeUInt16LE(0, 30);           // Extra field length
    centralHeader.writeUInt16LE(0, 32);           // File comment length
    centralHeader.writeUInt16LE(0, 34);           // Disk number start
    centralHeader.writeUInt16LE(0, 36);           // Internal file attributes
    centralHeader.writeUInt32LE(0, 38);           // External file attributes
    centralHeader.writeUInt32LE(offset, 42);      // Relative offset of local header

    centralHeaders.push(Buffer.concat([centralHeader, nameBuffer]));

    offset += localEntry.length;
  }

  // End of central directory record
  const centralDirData = Buffer.concat(centralHeaders);
  const centralDirOffset = offset;
  const centralDirSize = centralDirData.length;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);                // End of central directory signature
  eocd.writeUInt16LE(0, 4);                          // Number of this disk
  eocd.writeUInt16LE(0, 6);                          // Disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8);              // Number of central directory records on this disk
  eocd.writeUInt16LE(entries.length, 10);             // Total number of central directory records
  eocd.writeUInt32LE(centralDirSize, 12);             // Size of central directory
  eocd.writeUInt32LE(centralDirOffset, 16);           // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);                          // Comment length

  return Buffer.concat([...localHeaders, centralDirData, eocd]);
}

/**
 * CRC-32 computation (standard ZIP CRC-32).
 */
function crc32(data: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ 0xEDB88320;
      } else {
        crc = crc >>> 1;
      }
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Generate a human-readable text summary from the SOC 2 evidence.
 */
function generateSummary(evidence: Record<string, unknown>): string {
  const metadata = evidence.metadata as Record<string, unknown> | undefined;
  const completeness = evidence.completeness as Record<string, unknown> | undefined;
  const integrity = evidence.integrity as Record<string, unknown> | undefined;
  const accessLog = evidence.accessLog as Record<string, unknown> | undefined;
  const availability = evidence.availability as Record<string, unknown> | undefined;

  const lines: string[] = [
    "SOC 2 Evidence Package Summary",
    "==============================",
    "",
    `Generated: ${metadata?.generatedAt ?? new Date().toISOString()}`,
    `Project: ${metadata?.projectId ?? "unknown"}`,
    `Period: ${metadata?.startDate ?? "?"} to ${metadata?.endDate ?? "?"}`,
    "",
    "--- Completeness ---",
  ];

  if (completeness) {
    const sessions = completeness.sessions as Array<Record<string, unknown>> | undefined;
    lines.push(`Sessions analyzed: ${sessions?.length ?? 0}`);
    lines.push(`Truncated: ${completeness.truncated ? "yes" : "no"}`);
  }

  lines.push("");
  lines.push("--- Integrity ---");
  if (integrity) {
    lines.push(`Verified turns: ${integrity.verifiedCount ?? 0}`);
    lines.push(`Failed turns: ${integrity.failedCount ?? 0}`);
  }

  lines.push("");
  lines.push("--- Access Log ---");
  if (accessLog) {
    lines.push(`Total queries: ${accessLog.totalQueries ?? 0}`);
    lines.push(`Unique users: ${accessLog.uniqueUsers ?? 0}`);
  }

  lines.push("");
  lines.push("--- Availability ---");
  if (availability) {
    lines.push(`Heartbeat count: ${availability.heartbeatCount ?? 0}`);
    lines.push(`Gap count: ${availability.gapCount ?? 0}`);
    lines.push(`Availability: ${availability.availabilityPercentage ?? 100}%`);
  }

  lines.push("");
  lines.push("--- End of Summary ---");

  return lines.join("\n");
}

/**
 * POST /v1/exports/soc2/package
 *
 * Returns a ZIP buffer (not JSON). The caller must handle writing the
 * binary response with appropriate Content-Type.
 */
export async function handleSoc2Package(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; buffer?: Buffer; body?: Record<string, unknown>; contentType?: string }> {
  const projectId = body.projectId as string | undefined;

  if (!projectId) {
    return { status: 400, body: { error: "Missing required field: projectId" } };
  }

  // Project scoping
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  // Call existing SOC 2 export to get evidence JSON
  const soc2Result = await handleSoc2Export(body, apiKey);

  if (soc2Result.status !== 200) {
    return { status: soc2Result.status, body: soc2Result.body };
  }

  const evidence = soc2Result.body;
  const evidenceJson = JSON.stringify(evidence, null, 2);
  const summaryTxt = generateSummary(evidence);

  // Build ZIP
  const zipBuffer = buildZipBuffer([
    { name: "evidence.json", data: Buffer.from(evidenceJson, "utf-8") },
    { name: "summary.txt", data: Buffer.from(summaryTxt, "utf-8") },
  ]);

  return {
    status: 200,
    buffer: zipBuffer,
    contentType: "application/zip",
  };
}

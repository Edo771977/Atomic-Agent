import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { isIncognitoSession } from "./incognito.js";
import { writeEvidenceReceipt, type ProjectReceiptWriter } from "./project-receipts.js";
import { receiptHash } from "./receipt-signing.js";
import { criteriaById, gateVersion, validateMilestoneAttachments } from "./session-project.js";
import type { SessionState } from "./session-state.js";

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function attachmentHash(stateDir: string, path: string): string | null {
  try {
    const expected = join(realpathSync(stateDir), relative(resolve(stateDir), path));
    const actual = realpathSync(path);
    if (relative(expected, actual) !== "") return null;
    const file = openSync(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const before = fstatSync(file);
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_ATTACHMENT_BYTES) return null;
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(64 * 1024);
      let remaining = before.size;
      while (remaining > 0) {
        const size = readSync(file, chunk, 0, Math.min(chunk.length, remaining), null);
        if (size === 0) return null;
        hash.update(chunk.subarray(0, size));
        remaining -= size;
      }
      const after = fstatSync(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs || realpathSync(path) !== actual) return null;
      return hash.digest("hex");
    } finally {
      closeSync(file);
    }
  } catch {
    return null;
  }
}

export type SavedMilestoneReport = (session: SessionState, milestoneId: string) => void;

export function writeMilestoneReportReceipt(
  stateDir: string,
  writer: ProjectReceiptWriter,
  warn: (message: string) => void,
  session: SessionState,
  milestoneId: string,
): void {
  if (isIncognitoSession(session)) return;
  const project = session.project;
  const milestone = project?.milestones.find(m => m.id === milestoneId);
  if (!project || !milestone) {
    warn("Could not save a milestone evidence receipt because the saved milestone was missing.");
    return;
  }
  writeEvidenceReceipt(writer, warn, session, "milestone-report", () => {
    const criteria = criteriaById(project.brief);
    const attachments = (milestone.attachments ?? []).map(attachment => {
      const checked = validateMilestoneAttachments({ stateDir, milestone, attachments: [attachment] });
      const sha256 = checked.ok ? attachmentHash(stateDir, attachment.path) : null;
      return { sha256, criteria: attachment.criteria ?? [] };
    });
    if (attachments.some(attachment => attachment.sha256 === null)) {
      warn("Could not fingerprint a milestone attachment for its evidence receipt.");
    }
    const criteriaFacts = (milestone.criteriaFacts ?? []).map(({ id, state, why, reservation }) => {
      const criterion = criteria.get(id);
      return {
        id, state,
        ...(criterion === undefined ? {} : { criterionHash: receiptHash(criterion.text) }),
        ...(why === undefined ? {} : { whyHash: receiptHash(why) }),
        ...(reservation === undefined ? {} : { reservationHash: receiptHash(reservation) }),
      };
    });
    return { milestoneId, version: gateVersion(project), state: milestone.state, criteriaFacts, attachments };
  });
}

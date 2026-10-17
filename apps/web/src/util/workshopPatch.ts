import { PatchWorkshopBodySchema, type PatchWorkshopBody } from '@seatrelay/contracts';

/** Title and description as an organiser edits them (plan §2.2/§2.5 `PATCH /workshops/{wsId}`). */
export interface WorkshopDetails {
  title: string;
  description: string;
}

export type WorkshopPatch =
  | { kind: 'unchanged' }
  | { kind: 'invalid'; issues: string[] }
  | { kind: 'patch'; body: PatchWorkshopBody };

/** Only the changed fields, validated with the contracts schema the API uses. */
export function buildWorkshopPatch(
  current: WorkshopDetails,
  draft: WorkshopDetails,
): WorkshopPatch {
  const title = draft.title.trim();
  const body: { title?: string; description?: string } = {};
  if (title !== current.title) {
    body.title = title;
  }
  if (draft.description !== current.description) {
    body.description = draft.description;
  }
  if (body.title === undefined && body.description === undefined) {
    return { kind: 'unchanged' };
  }
  const parsed = PatchWorkshopBodySchema.safeParse(body);
  if (!parsed.success) {
    return {
      kind: 'invalid',
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'details'}: ${issue.message}`,
      ),
    };
  }
  return { kind: 'patch', body: parsed.data };
}

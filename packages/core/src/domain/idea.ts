import { z } from "zod";

/** Idea lifecycle — single source of truth for status transitions. */
export const IdeaStatusSchema = z.enum([
  "new",
  "approved",
  "rejected",
  "later",
  "in_research",
  "researched",
  "scripted",
  "in_production",
  "ready_to_publish",
  "published",
]);
export type IdeaStatus = z.infer<typeof IdeaStatusSchema>;

export const IdeaScoresSchema = z.object({
  velocity: z.number(),
  acceleration: z.number(),
  clusterScore: z.number(),
  opportunity: z.number(),
});
export type IdeaScores = z.infer<typeof IdeaScoresSchema>;

const ALLOWED: Record<IdeaStatus, IdeaStatus[]> = {
  new: ["approved", "rejected", "later"],
  later: ["approved", "rejected"],
  approved: ["in_research", "rejected"],
  in_research: ["researched"],
  researched: ["scripted"],
  scripted: ["in_production"],
  in_production: ["ready_to_publish"],
  ready_to_publish: ["published"],
  rejected: [],
  published: [],
};

export function canTransition(from: IdeaStatus, to: IdeaStatus): boolean {
  return ALLOWED[from].includes(to);
}

import { z } from "zod";
import { buildRegistry } from "./registry.js";
import type { LoadedProject } from "../types.js";
export const mentionSchema = z
  .object({
    displayName: z.string().min(1).max(20000),
    logicalObjectId: z.string().max(180),
    sceneId: z.string().max(180),
    sourceNodeId: z.string().max(180),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict();
export type ObjectMention = z.infer<typeof mentionSchema>;
export function validateMentions(
  project: LoadedProject,
  text: string,
  mentions: ObjectMention[],
) {
  const registry = buildRegistry(project.inspection.document,project.inspection.fingerprint);
  let end = 0;
  return [...mentions]
    .sort((a, b) => a.start - b.start)
    .map((m) => {
      const object = registry.objects.find(
        (o) => o.logicalObjectId === m.logicalObjectId,
      );
      if (
        m.start < end ||
        m.end <= m.start ||
        text.slice(m.start, m.end) !== m.displayName ||
        object?.name !== m.displayName ||
        !object.sourceInstances.some(
          (i) => i.sceneId === m.sceneId && i.sourceNodeId === m.sourceNodeId,
        )
      )
        throw new Error(
          "Ссылка на объект устарела. Выберите объект в preview ещё раз.",
        );
      end = m.end;
      return m;
    });
}

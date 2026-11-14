import {z} from 'zod';

const renderedFrames=z.object({frames:z.array(z.number().int()).min(1).max(8),logicalObjectIds:z.array(z.string()).max(20).optional()}).strict();
const sampledObject=z.object({sceneId:z.string(),targetId:z.string(),frames:z.array(z.number().int()).min(1).max(65)}).strict();
export const inspectionArgumentSchemas={
  renderFrame:renderedFrames,renderFrameSequence:renderedFrames,
  sampleAnimation:sampledObject,evaluateObjectAtTime:sampledObject,
  inspectSceneState:z.object({sceneId:z.string(),offset:z.number().int().nonnegative().optional()}).strict(),
};
/** These are actual accepted argument examples, never descriptions disguised as keys. */
export const inspectionArgumentExamples={
  renderFrame:{frames:[0]},renderFrameSequence:{frames:[0,1]},
  sampleAnimation:{sceneId:'ID',targetId:'ID',frames:[0,15,30]},
  evaluateObjectAtTime:{sceneId:'ID',targetId:'ID',frames:[0,1]},
  inspectSceneState:{sceneId:'ID'},
};
export const inspectionLimits={
  renderMaxFramesPerCall:8,evaluationMaxFramesPerCall:65,
  optionalRenderArguments:'logicalObjectIds:string[] focuses geometry only; pixels still show the complete scene',
  optionalSceneStateArguments:'offset:nonnegative integer; reference geometry only, no frame argument',
};

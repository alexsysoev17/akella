// Keep standalone tooling on the same exporter implementation as the application.
import { tsImport } from 'tsx/esm/api';
const implementation = await tsImport('../apps/scene-validator/src/figma-code.ts', import.meta.url);
export const frameExportCode = implementation.frameExportCode;
export const discoveryCode = implementation.discoveryCode;
export const previewSignatureCode = implementation.previewSignatureCode;

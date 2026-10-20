/**
 * Core's output masking: the functions, and the registry of the ways out
 * (AD-11, 마스킹 B).
 *
 * Named one by one rather than with `export *`, so that adding something here
 * is a decision somebody made rather than a side effect.
 */
export {
  TOOL_NOTE_TARGET_LIMIT,
  maskOutputText,
  maskOutputValue,
  maskToolNoteTarget,
  toolNoteForOutput,
  type MaskableToolNote,
} from './mask.js';
export {
  OUTPUT_CODECS,
  encodeHookLine,
  encodeHookOutput,
  encodeTextLine,
  type OutputCodec,
  type OutputProbe,
} from './codecs.js';

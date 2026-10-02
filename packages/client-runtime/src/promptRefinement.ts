import { PROMPT_REFINEMENT_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

/**
 * One composer's refinement, pinned to the draft text it applies to. The
 * composer outlives a thread switch and the user can keep typing, so the phase
 * is derived from whether the live draft still matches, never stored.
 */
export type PromptRefinementState =
  | { readonly kind: "refining"; readonly targetKey: string; readonly draft: string }
  | {
      readonly kind: "refined";
      readonly targetKey: string;
      readonly original: string;
      readonly refined: string;
    };

export type PromptRefinementPhase = "idle" | "refining" | "refined";

/** Editing the draft or switching composers drops back to idle: that is how a refinement is cancelled. */
export function promptRefinementPhase(
  state: PromptRefinementState | null,
  targetKey: string,
  prompt: string,
): PromptRefinementPhase {
  if (state === null || state.targetKey !== targetKey) return "idle";
  const pinned = state.kind === "refining" ? state.draft : state.refined;
  return pinned === prompt ? state.kind : "idle";
}

/** A draft is worth refining when it has prose of its own and the server will accept it. */
export function canRefinePrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  return (
    trimmed.length <= PROMPT_REFINEMENT_MAX_INPUT_CHARS &&
    replaceComposerContextReferences(trimmed, () => "").trim().length > 0
  );
}

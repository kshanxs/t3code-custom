/**
 * PromptRefinement - Rewrites a composer draft with the environment's text
 * generation model. The result goes back to the composer; nothing is sent.
 *
 * @module PromptRefinement
 */
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  type PromptRefinementInput,
  type PromptRefinementResult,
  TextGenerationError,
} from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "./TextGeneration.ts";

// Clients mark an inline terminal context with this character; the nth one
// belongs to the nth attached context.
const INLINE_PLACEHOLDER = "\uFFFC";

function inlineAttachmentTokens(prompt: string): ReadonlyArray<string> {
  return [
    // The label is cosmetic; the kind and id are what bind the attachment.
    ...collectComposerContextReferences(prompt).map(
      (reference) => `${reference.kind}/${reference.contextId}`,
    ),
    ...Array.from(prompt).filter((char) => char === INLINE_PLACEHOLDER),
  ].sort();
}

/**
 * Whether a rewrite kept every inline attachment the draft carried. A dropped
 * or invented reference would detach context the user attached, so such a
 * rewrite is rejected rather than repaired.
 */
function keepsInlineAttachments(draft: string, refined: string): boolean {
  const expected = inlineAttachmentTokens(draft);
  const actual = inlineAttachmentTokens(refined);
  return expected.length === actual.length && expected.every((token, i) => token === actual[i]);
}

export class PromptRefinement extends Context.Service<
  PromptRefinement,
  {
    /** Rewrite a draft for clarity, keeping its intent and inline attachments. */
    readonly refine: (
      input: PromptRefinementInput,
    ) => Effect.Effect<PromptRefinementResult, TextGenerationError>;
  }
>()("t3/textGeneration/PromptRefinement") {}

const make = Effect.gen(function* () {
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const refine: PromptRefinement["Service"]["refine"] = Effect.fn("PromptRefinement.refine")(
    function* (input) {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "refinePrompt",
              detail: "Failed to read settings.",
              cause,
            }),
        ),
      );
      if (!settings.enablePromptRefinement) {
        return yield* new TextGenerationError({
          operation: "refinePrompt",
          detail: "Prompt refinement is turned off in settings.",
        });
      }

      const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
        settings,
        input.projectId ?? null,
      ).settings;
      const generated = yield* textGeneration.refinePrompt({
        // The rewrite needs only the draft, so providers run outside any checkout.
        cwd: NodeOS.tmpdir(),
        prompt: input.prompt,
        modelSelection,
      });

      if (generated.prompt.length === 0) {
        return yield* new TextGenerationError({
          operation: "refinePrompt",
          detail: "The model returned an empty prompt.",
        });
      }
      if (!keepsInlineAttachments(input.prompt, generated.prompt)) {
        return yield* new TextGenerationError({
          operation: "refinePrompt",
          detail: "The rewrite dropped attached context, so the draft was left unchanged.",
        });
      }
      return { prompt: generated.prompt };
    },
  );

  return PromptRefinement.of({ refine });
});

export const layer = Layer.effect(PromptRefinement, make);

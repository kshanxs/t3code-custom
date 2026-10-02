import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { ProjectId, ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import * as ServerSettingsModule from "../serverSettings.ts";
import * as PromptRefinement from "./PromptRefinement.ts";
import * as TextGeneration from "./TextGeneration.ts";

type DeepPartialSettings = Parameters<typeof ServerSettingsModule.layerTest>[0];

const FILE_REFERENCE = "[notes.md](t3-context://v1/file/file_notes)";

const refine = (
  prompt: string,
  options: {
    readonly rewrite: (input: TextGeneration.PromptRefinementGenerationInput) => string;
    readonly settings?: DeepPartialSettings;
    readonly projectId?: ProjectId;
  },
) =>
  Effect.gen(function* () {
    const refinement = yield* PromptRefinement.PromptRefinement;
    return yield* refinement.refine({
      prompt,
      ...(options.projectId ? { projectId: options.projectId } : {}),
    });
  }).pipe(
    Effect.provide(
      PromptRefinement.layer.pipe(
        Layer.provide(
          Layer.mock(TextGeneration.TextGeneration)({
            refinePrompt: (input) => Effect.succeed({ prompt: options.rewrite(input) }),
          }),
        ),
        Layer.provide(ServerSettingsModule.layerTest(options.settings).pipe(Layer.orDie)),
      ),
    ),
  );

describe("PromptRefinement.refine", () => {
  it.effect("returns the rewrite and keeps a relabelled attachment", () =>
    Effect.gen(function* () {
      const result = yield* refine(`fix teh bug in ${FILE_REFERENCE} pls`, {
        rewrite: () => "Fix the bug in [my notes](t3-context://v1/file/file_notes).",
      });
      expect(result.prompt).toBe("Fix the bug in [my notes](t3-context://v1/file/file_notes).");
    }),
  );

  it.effect("rejects a rewrite that drops an attached context", () =>
    Effect.gen(function* () {
      const error = yield* refine(`fix teh bug in ${FILE_REFERENCE} pls`, {
        rewrite: () => "Fix the bug in the notes.",
      }).pipe(Effect.flip);
      expect(error.detail).toContain("dropped attached context");
    }),
  );

  it.effect("rejects a rewrite that drops an inline terminal placeholder", () =>
    Effect.gen(function* () {
      const error = yield* refine("why does \uFFFC fail", {
        rewrite: () => "Why does this fail?",
      }).pipe(Effect.flip);
      expect(error.detail).toContain("dropped attached context");
    }),
  );

  it.effect("refuses to call a model when the setting is off", () =>
    Effect.gen(function* () {
      const error = yield* refine("fix teh bug", {
        rewrite: () => {
          throw new Error("The model must not run while refinement is off.");
        },
        settings: { enablePromptRefinement: false },
      }).pipe(Effect.flip);
      expect(error.detail).toContain("turned off");
    }),
  );

  it.effect("uses the project's text generation model override", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-1");
      const override = createModelSelection(ProviderInstanceId.make("claudeAgent"), "haiku");
      let used: ServerSettings["textGenerationModelSelection"] | undefined;
      yield* refine("fix teh bug", {
        rewrite: (input) => {
          used = input.modelSelection;
          return "Fix the bug.";
        },
        settings: {
          projectSettingsOverrides: { [projectId]: { textGenerationModelSelection: override } },
        },
        projectId,
      });
      expect(used).toEqual(override);
    }),
  );
});
